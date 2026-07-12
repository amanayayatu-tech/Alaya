#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  evaluateDecisionTsr,
  inferOracleSideFromValue,
  oracleEventFields,
  oracleMetadataForSide,
  scoreResolutionEvent,
} from "./lib/health-signal-quality.mjs";
import { buildCognitionCoverageEvidence } from "./lib/cognition-coverage-scenario.mjs";
import { createLearningCaseHardStop } from "./lib/learning-case-hard-stop.mjs";
import {
  bindLearningPrediction,
  buildLearningCaseProjectPatch,
  buildLearningCaseVisiblePrompt,
  causalCycleFromSchedulerTicks,
  compareHeldoutKnowledgeState,
  heldoutWritePolicy,
  learningCaseGroundTruth as runtimeLearningCaseGroundTruth,
  learningCaseId as runtimeLearningCaseId,
  learningQueueDrainStatus,
  parseRuntimePredictionContract,
} from "./lib/learning-runtime-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REQUIRED_LLM_PROVIDER = "openai";
const REQUIRED_OPENAI_BASE_URL = "https://api.minimax.io/openai";
const REQUIRED_OPENAI_MODEL = "MiniMax-M3";
const LAUNCH_GUARD_FAILURE_EXIT_CODE = 2;

const PROJECT_NAME = "equity-thesis-position-decision";
function projectDescription() {
  return [
    "你是某个股投研与仓位决策系统。你需要对同一只目标个股做出多空研判与仓位决策：",
    "在当前财报窗口与事件催化不确定的背景下，应该优先采用 单边看多、单边看空，还是多空分层仓位方案？",
    "",
    "已知约束：单票仓位上限 12%，组合最大回撤预算 8%，财报窗口前后不得裸露单边高杠杆仓位，必须记录关键假设、反证与风险预算。",
    "",
    `本次验证窗口为 ${durationTextZh}，每 5 分钟采样一次。每轮必须复用当前知识库，不得只重算单轮结论；最终需要观察知识熵变、Human Gate 收敛、冲突解决和 Stall Guard 触发率。`,
    "",
    "每轮任务：基于当前知识库，给出当前最优仓位决策，并列明置信度与关键证据。如果遇到多空矛盾证据，必须在知识库中记录 conflict 并等待人工审核。",
  ].join("\n");
}

const STARTUP_FINDINGS = [
  {
    severity: "P2",
    title: "first four cycle stimuli are partly hard-coded to the generic high-risk automation scenario",
    detail: "The equity-thesis onboarding prompt affects seed/project context, but the built-in flywheel scenarios still inject generic product automation feedback. The runner adds long/short contradiction evidence through the form-feedback path to test the conflict pipeline.",
  },
];

function evidenceTemplate(input) {
  return {
    ...input,
    ...oracleMetadataForSide(input.side),
  };
}

const EVIDENCE_TEMPLATES = [
  evidenceTemplate({
    side: "long_support",
    title: "看多优先证据：基本面上修与估值修复",
    text: [
      "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振，基本面上行更支持多头仓位。",
      "long_thesis_score >= 0.78。",
      "明确冲突：该结论与“看空优先”互相矛盾，必须进入 conflict 知识状态并等待人工审核。",
      "当前最优仓位决策：优先做多，置信度 0.64。",
      "关键证据：订单恢复、利润率弹性、估值修复和现金流改善更匹配多头论点。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "short_support",
    title: "看空优先证据：盈利下修与估值压缩",
    text: [
      "看空优先：收入指引下修、费用率上行和估值倍数压缩使空头论点更有解释力。",
      "long_thesis_score <= 0.35。",
      "明确冲突：该结论与“看多优先”互相矛盾，必须进入 conflict 知识状态并等待人工审核。",
      "当前最优仓位决策：优先做空，置信度 0.66。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "long_risk",
    title: "看多反证：估值拥挤与盈利兑现风险",
    text: [
      "看多反证：估值分位过高、盈利兑现滞后和多头拥挤会削弱单边看多结论。",
      "long_thesis_score <= 0.42。",
      "明确冲突：该证据削弱之前看多优先结论，不能直接复用为 active 决策依据。",
      "建议：保留核心多头观察仓位，但需要空头或现金对冲控制回撤。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "short_risk",
    title: "看空反证：回补风险与上行催化",
    text: [
      "看空反证：空头拥挤、回补风险和潜在上行催化会抬高单边做空的损失概率。",
      "long_thesis_score >= 0.72。",
      "明确冲突：该证据反驳看空优先，必须隔离到冲突审查流程。",
      "当前最优仓位决策：核心多头配合空头/现金对冲，置信度 0.61。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "tiered_support",
    title: "分层仓位证据：核心多头 + 空头对冲",
    text: [
      "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
      "tiered_thesis_confidence >= 0.81。",
      "明确冲突：分层仓位方案与单边看多/单边看空结论都存在边界冲突，需要人工审核选择约束优先级。",
      "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "tiered_reject",
    title: "分层仓位反证：交易成本与对冲拖累",
    text: [
      "反对分层仓位：同时持有核心多头和空头/现金对冲会抬高交易成本、保证金占用和执行复杂度，可能拖累组合收益。",
      "tiered_thesis_confidence <= 0.38。",
      "明确冲突：该结论与分层仓位推荐互相矛盾，不能同时作为 active 知识复用。",
      "当前最优仓位决策：先做多，保留空头对冲作为风险预算触发项，置信度 0.63。",
    ].join("\n"),
  }),
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = "true";
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

const rawArgv = process.argv.slice(2);
const args = parseArgs(rawArgv);

if (args.help || rawArgv.includes("-h")) {
  console.log([
    "Usage: node scripts/health-signal-36h-validation.mjs [options]",
    "",
    "Required launch guard inputs:",
    "  PORT or --port=<number>",
    "  ALAYA_DB_PATH or --db-path=<path>",
    "  ALAYA_SCHEDULER=false",
    "  ALAYA_AUTO_SEED_DEMO=false",
    "  ALAYA_LLM_PROVIDER=openai",
    "  OPENAI_BASE_URL=https://api.minimax.io/openai",
    "  OPENAI_MODEL=MiniMax-M3",
    "  OPENAI_API_KEY or OPENAI_API_KEY_FILE",
    "",
    "Common options:",
    "  --scenario=<standard|conflict-flood|cognition-coverage|learning-cases>",
    "  --learning-cases-path=<path>     required for learning-cases unless ALAYA_LEARNING_CASES_PATH is set",
    "  --learning-cases-per-sample=<n>   default: enough to consume all cases within max samples",
    "  --log-dir=<path>",
    "  --duration-hours=<number>        default: 36",
    "  --duration-minutes=<number>      default: 0",
    "  --sample-minutes=<number>        default: 5",
    "  --max-samples=<number>",
    "  --check-only                     validate launch guard and exit",
    "  --start-app=<true|false>         default: true",
    "  --keep-app=<true|false>          default: false",
    "  --llm-provider=openai",
    "  --model=MiniMax-M3",
  ].join("\n"));
  process.exit(0);
}

function numArg(name, fallback) {
  const raw = args[name];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolArg(name, fallback) {
  const raw = args[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function createPrng(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledWithPrng(items, prng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readNonEmptySecretFile(path) {
  if (!path?.trim()) return { usable: false, reason: "path is empty" };
  try {
    return readFileSync(path, "utf8").trim()
      ? { usable: true, reason: "" }
      : { usable: false, reason: "file is empty" };
  } catch (error) {
    return {
      usable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseExplicitPort(raw) {
  if (!raw?.trim()) return { ok: false, error: "PORT or --port must be explicitly set." };
  if (!/^\d+$/.test(raw.trim())) return { ok: false, error: `PORT must be an integer, got ${JSON.stringify(raw)}.` };
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, error: `PORT must be in 1..65535, got ${JSON.stringify(raw)}.` };
  }
  return { ok: true, port };
}

function healthSignalLaunchGuard({ argv, env }) {
  const errors = [];
  const portRaw = argv.port ?? env.PORT ?? "";
  const dbPathRaw = argv["db-path"] ?? env.ALAYA_DB_PATH ?? "";
  const portCheck = parseExplicitPort(String(portRaw));
  if (!portCheck.ok) errors.push(portCheck.error);
  if (!dbPathRaw?.trim()) errors.push("ALAYA_DB_PATH or --db-path must be explicitly set.");

  if (env.ALAYA_SCHEDULER !== "false") {
    errors.push(`ALAYA_SCHEDULER must be explicitly set to false, got ${JSON.stringify(env.ALAYA_SCHEDULER ?? "")}.`);
  }
  if (env.ALAYA_AUTO_SEED_DEMO !== "false") {
    errors.push(`ALAYA_AUTO_SEED_DEMO must be explicitly set to false, got ${JSON.stringify(env.ALAYA_AUTO_SEED_DEMO ?? "")}.`);
  }
  if (env.ALAYA_LLM_PROVIDER !== REQUIRED_LLM_PROVIDER) {
    errors.push(`ALAYA_LLM_PROVIDER must be ${REQUIRED_LLM_PROVIDER}, got ${JSON.stringify(env.ALAYA_LLM_PROVIDER ?? "")}.`);
  }
  if (argv["llm-provider"] && argv["llm-provider"] !== REQUIRED_LLM_PROVIDER) {
    errors.push(`--llm-provider must be ${REQUIRED_LLM_PROVIDER}, got ${JSON.stringify(argv["llm-provider"])}.`);
  }
  if (env.OPENAI_BASE_URL !== REQUIRED_OPENAI_BASE_URL) {
    errors.push(`OPENAI_BASE_URL must be ${REQUIRED_OPENAI_BASE_URL}, got ${JSON.stringify(env.OPENAI_BASE_URL ?? "")}.`);
  }
  if (env.OPENAI_MODEL !== REQUIRED_OPENAI_MODEL) {
    errors.push(`OPENAI_MODEL must be ${REQUIRED_OPENAI_MODEL}, got ${JSON.stringify(env.OPENAI_MODEL ?? "")}.`);
  }
  if (argv.model && argv.model !== REQUIRED_OPENAI_MODEL) {
    errors.push(`--model must be ${REQUIRED_OPENAI_MODEL}, got ${JSON.stringify(argv.model)}.`);
  }

  const hasInlineKey = Boolean(env.OPENAI_API_KEY?.trim());
  const keyFile = env.OPENAI_API_KEY_FILE?.trim() || "";
  const keyFileCheck = hasInlineKey ? { usable: false, reason: "inline key present" } : readNonEmptySecretFile(keyFile);
  if (!hasInlineKey && !keyFileCheck.usable) {
    errors.push(`OPENAI_API_KEY or a non-empty OPENAI_API_KEY_FILE is required for real MiniMax validation${keyFile ? `; OPENAI_API_KEY_FILE=${keyFile} is unusable (${keyFileCheck.reason})` : ""}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    config: {
      port: portCheck.ok ? portCheck.port : null,
      dbPath: dbPathRaw?.trim() || null,
      scheduler: env.ALAYA_SCHEDULER ?? null,
      autoSeedDemo: env.ALAYA_AUTO_SEED_DEMO ?? null,
      llmProvider: env.ALAYA_LLM_PROVIDER ?? null,
      openaiBaseUrl: env.OPENAI_BASE_URL ?? null,
      openaiModel: env.OPENAI_MODEL ?? null,
      hasOpenaiApiKey: hasInlineKey,
      openaiApiKeyFile: keyFile || null,
      openaiApiKeyFileUsable: keyFile ? keyFileCheck.usable : false,
    },
  };
}

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

const checkOnly = boolArg("check-only", false);
const launchGuard = healthSignalLaunchGuard({ argv: args, env: process.env });
if (checkOnly) {
  console.log(JSON.stringify(launchGuard, null, 2));
  process.exit(launchGuard.ok ? 0 : LAUNCH_GUARD_FAILURE_EXIT_CODE);
}
if (!launchGuard.ok) {
  console.error("Equity Thesis validation launch guard failed:");
  for (const error of launchGuard.errors) console.error(`- ${error}`);
  process.exit(LAUNCH_GUARD_FAILURE_EXIT_CODE);
}

const durationHours = numArg("duration-hours", 36);
const durationMinutes = numArg("duration-minutes", 0);
const durationLabel = durationMinutes > 0 ? `${durationHours}h${durationMinutes}m` : `${durationHours}h`;
const durationTextZh = durationMinutes > 0 ? `${durationHours} 小时 ${durationMinutes} 分钟` : `${durationHours} 小时`;
const durationMs = Math.max(1_000, durationHours * 3_600_000 + durationMinutes * 60_000);
const sampleMs = Math.max(1_000, numArg("sample-minutes", 5) * 60_000 + numArg("sample-seconds", 0) * 1_000);
const explicitMaxSamples = Math.trunc(numArg("max-samples", Number.POSITIVE_INFINITY));
const durationBoundedMaxSamples = Math.ceil(durationMs / sampleMs) + 1;
const maxSamples = Math.max(1, Math.min(durationBoundedMaxSamples, explicitMaxSamples));
const scenario = args.scenario || "standard";
if (!["standard", "conflict-flood", "cognition-coverage", "learning-cases"].includes(scenario)) {
  console.error(`Unsupported --scenario=${JSON.stringify(scenario)}. Expected standard, conflict-flood, cognition-coverage, or learning-cases.`);
  process.exit(2);
}
const startApp = boolArg("start-app", true);
const keepApp = boolArg("keep-app", false);
const llmProvider = args["llm-provider"] || process.env.ALAYA_LLM_PROVIDER || "openai";
const openaiModel = args.model || process.env.OPENAI_MODEL || "MiniMax-M3";
const baseUrlArg = args["base-url"];
const requestedPort = launchGuard.config.port;
const logDir = resolve(args["log-dir"] || join(ROOT, "validation-logs", `health-signal-${durationLabel}_${timestampForPath()}`));
const decisionVia = args["decision-via"] || "local_api_human_proxy";
const approveMeaning = boolArg("approve-meaning-gates", true);
const holdReviewRequiredMeaning = boolArg("hold-review-required-meaning-gates", true);
const holdEveryMeaning = Math.max(0, Math.trunc(numArg("hold-every-meaning", 10)));
const holdEveryMeaningUntilSample = args["hold-every-meaning-until-sample"] == null
  ? Number.POSITIVE_INFINITY
  : Math.max(0, Math.trunc(numArg("hold-every-meaning-until-sample", 0)));
const resolveConflictReviewsTarget = Math.max(0, Math.trunc(numArg("resolve-conflict-reviews", 9999)));
const injectEverySamples = Math.max(1, Math.trunc(numArg("inject-every-samples", 1)));
const progressTicksPerSample = Math.max(1, Math.trunc(numArg("progress-ticks-per-sample", 6)));
const conflictFloodHoldSamples = scenario === "conflict-flood" ? Math.max(1, Math.floor(maxSamples * 0.25)) : 0;
const conflictFloodMaxResolutionsPerSample = scenario === "conflict-flood" ? Math.max(1, Math.trunc(numArg("conflict-flood-max-resolutions-per-sample", 3))) : Number.POSITIVE_INFINITY;
const cognitionCoveragePerSample = scenario === "cognition-coverage" ? Math.max(1, Math.trunc(numArg("cognition-coverage-per-sample", 3))) : 0;
const qualityCanaryEverySamples = Math.max(0, Math.trunc(numArg("quality-canary-every-samples", 5)));
const seed = args.seed == null ? null : Math.trunc(numArg("seed", 0));
const runId = args["run-id"] || null;
const seedPrng = seed == null ? null : createPrng(seed);
const evidenceSchedule = scenario === "cognition-coverage"
  ? [buildCognitionCoverageEvidence(1)]
  : (seedPrng ? shuffledWithPrng(EVIDENCE_TEMPLATES, seedPrng) : EVIDENCE_TEMPLATES);
const qualityCanaryOffsetSamples = seedPrng && qualityCanaryEverySamples > 0
  ? Math.floor(seedPrng() * qualityCanaryEverySamples)
  : 0;

mkdirSync(logDir, { recursive: true });
const monitorCsv = join(logDir, "monitor_log.csv");
const eventsJsonl = join(logDir, "events.jsonl");
const issuesMd = join(logDir, "issues.md");
const summaryJson = join(logDir, "summary.json");
const appLogPath = join(logDir, "app.log");
const runnerLogPath = join(logDir, "runner.log");
const metricsDir = join(logDir, "metrics");
const opsTrendWarningsPath = join(logDir, "ops_trend_warnings.log");
const watchdogPath = join(logDir, "watchdog.jsonl");
const dbPath = resolve(launchGuard.config.dbPath);
const metricsSnapshotMinutes = Math.max(0, numArg("metrics-snapshot-minutes", 0));
const watchdogMinutes = Math.max(0, numArg("watchdog-minutes", 0));
const knowledgeRetrievalControlPath = scenario === "learning-cases"
  ? resolve(process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH || join(logDir, "knowledge-retrieval-control.json"))
  : null;
const REQUIRED_MODEL_CALLING_AGENTS = Object.freeze(["orchestrator", "sensor", "builder", "distiller", "librarian"]);

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(runnerLogPath, `${line}\n`);
  console.error(line);
}

function event(eventType, data = {}) {
  appendFileSync(eventsJsonl, `${JSON.stringify({ ts: new Date().toISOString(), eventType, ...data })}\n`);
}

function writeKnowledgeRetrievalControl(identity) {
  if (!knowledgeRetrievalControlPath) throw new Error("learning-case retrieval control path is unavailable");
  if (identity?.mode !== "mutating" && identity?.mode !== "read_only") {
    throw new Error(`invalid learning-case retrieval mode: ${String(identity?.mode)}`);
  }
  const payload = {
    schema: "alaya.learning_loop.retrieval_control.v1",
    projectId: String(identity?.projectId ?? "").trim(),
    runId: String(identity?.runId ?? "").trim(),
    caseId: String(identity?.caseId ?? "").trim(),
    cycleId: String(identity?.cycleId ?? "").trim(),
    mode: identity.mode,
  };
  if (!payload.projectId || !payload.runId || !payload.caseId || !payload.cycleId) {
    throw new Error("learning-case retrieval control requires projectId, runId, caseId, and cycleId");
  }
  const tempPath = `${knowledgeRetrievalControlPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  renameSync(tempPath, knowledgeRetrievalControlPath);
  event("knowledge_retrieval_control", {
    ...payload,
    auditBoundary: "non_model_runtime_control",
  });
  return payload;
}

async function knowledgeRetrievalIdentity(baseUrl, projectId, caseId, mode) {
  if (!runId) throw new Error("learning-case scheduler requests require runId");
  const cycles = await requestJson(baseUrl, `/api/projects/${projectId}/cycles`);
  const current = cycles.find((cycle) => cycle.status !== "closed") ?? cycles.at(-1);
  if (!current?.id) throw new Error(`learning-case ${caseId} has no current cycle for retrieval identity`);
  return {
    schema: "alaya.learning_loop.retrieval_control.v1",
    projectId,
    runId,
    caseId,
    cycleId: current.id,
    mode,
  };
}

async function requestLearningSchedulerTick(baseUrl, projectId, { caseId, mode }) {
  const identity = await knowledgeRetrievalIdentity(baseUrl, projectId, caseId, mode);
  writeKnowledgeRetrievalControl(identity);
  return requestJson(baseUrl, `/api/projects/${projectId}/scheduler/tick`, {
    method: "POST",
    body: { syncFeedback: false, knowledgeRetrievalIdentity: identity },
  });
}

function issue(finding) {
  const line = [
    `\n## ${finding.severity || "P2"} ${finding.title}`,
    "",
    finding.detail,
    finding.evidence ? `\nEvidence: ${finding.evidence}` : "",
  ].join("\n");
  appendFileSync(issuesMd, `${line}\n`);
  event("issue", finding);
}

const existingRun = existsSync(monitorCsv) || existsSync(eventsJsonl) || existsSync(issuesMd);

if (!existsSync(issuesMd)) {
  writeFileSync(issuesMd, `# Equity Thesis ${durationLabel} Validation Issues\n\nLog dir: ${logDir}\n`);
  for (const finding of STARTUP_FINDINGS) issue(finding);
}

if (!existsSync(monitorCsv)) {
  writeFileSync(
    monitorCsv,
    [
      "sample",
      "epoch",
      "iso",
      "round1vs4KnowledgeDelta",
      "round1vsCurrentKnowledgeDelta",
      "pendingGates",
      "knowledgeCount",
      "activeCount",
      "conflictCount",
      "strongCount",
      "quarantinedCount",
      "deprecatedCount",
      "totalGates",
      "directionPending",
      "meaningPending",
      "riskPending",
      "openConflictReviews",
      "resolvedConflictReviews",
      "stallGuardCount",
      "cyclesTotal",
      "cyclesClosed",
      "newGatesThisHour",
      "llmTokenSource",
      "llmEstimatedCostUsd",
      "appRssMb",
      "lastSchedulerAction",
      "lastDecisionVia",
    ].join(",") + "\n",
  );
}

function lastRecordedSample() {
  if (!existsSync(monitorCsv)) return 0;
  const lines = readFileSync(monitorCsv, "utf8").trim().split(/\r?\n/).slice(1);
  let max = 0;
  for (const line of lines) {
    const sample = Number(line.split(",")[0]);
    if (Number.isFinite(sample)) max = Math.max(max, sample);
  }
  return max;
}

function firstRecordedSampleIso() {
  if (!existsSync(monitorCsv)) return null;
  const lines = readFileSync(monitorCsv, "utf8").trim().split(/\r?\n/);
  const header = lines.shift()?.split(",") ?? [];
  const isoIndex = header.indexOf("iso");
  if (isoIndex < 0) return null;
  for (const line of lines) {
    const iso = line.split(",")[isoIndex];
    if (iso && Number.isFinite(Date.parse(iso))) return iso;
  }
  return null;
}

function readMonitorSamples() {
  if (!existsSync(monitorCsv)) return [];
  const lines = readFileSync(monitorCsv, "utf8").trim().split(/\r?\n/);
  const header = lines.shift()?.split(",") ?? [];
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split(",");
      return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
    });
}

function readEvents() {
  if (!existsSync(eventsJsonl)) return [];
  return readFileSync(eventsJsonl, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { eventType: "unparseable_jsonl", raw: line };
      }
    });
}

function readLearningCasesFile(path) {
  if (!path?.trim()) {
    console.error("learning-cases scenario requires --learning-cases-path or ALAYA_LEARNING_CASES_PATH.");
    process.exit(2);
  }
  const resolvedPath = resolve(path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    console.error(`Unable to read learning cases from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error(`Learning cases file ${resolvedPath} must contain a non-empty cases array.`);
    process.exit(2);
  }
  return { path: resolvedPath, cases };
}

function learningCaseId(testCase) {
  return runtimeLearningCaseId(testCase);
}

function learningCaseGroundTruth(testCase) {
  return runtimeLearningCaseGroundTruth(testCase);
}

function learningCasePrompt(testCase) {
  return buildLearningCaseVisiblePrompt(testCase);
}

function learningCaseProjectPatch(testCase) {
  return buildLearningCaseProjectPatch(testCase);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function traceAttributes(trace) {
  return parseJsonObject(trace?.attributes);
}

function latestKnowledgeInjectionTrace(traces = []) {
  return [...traces].reverse().find((trace) => trace?.kind === "knowledge_injection" || trace?.name === "build_prior_knowledge_context") ?? null;
}

function comparablePrediction(prediction) {
  if (!prediction) return null;
  return {
    id: prediction.id ?? null,
    cycleId: prediction.cycleId ?? null,
    belief: prediction.belief ?? "",
    prediction: prediction.prediction ?? "",
    action: prediction.action ?? "",
    status: prediction.status ?? null,
    knowledgeRefs: Array.isArray(prediction.knowledgeRefs) ? prediction.knowledgeRefs : [],
  };
}

function lastCognitionCoverageOrdinal() {
  return readEvents().reduce((max, event) => {
    const ordinal = Number(event.coverageOrdinal);
    return Number.isFinite(ordinal) ? Math.max(max, ordinal) : max;
  }, 0);
}

function lastLearningCaseOrdinal() {
  return readEvents().reduce((max, eventItem) => {
    if (eventItem.eventType !== "learning_case_resolved") return max;
    const ordinal = Number(eventItem.ordinal ?? eventItem.caseIndex ?? eventItem.cycleIdx);
    return Number.isFinite(ordinal) ? Math.max(max, ordinal) : max;
  }, 0);
}

const learningCasesPath = args["learning-cases-path"] || process.env.ALAYA_LEARNING_CASES_PATH || "";
const learningCasesInput = scenario === "learning-cases"
  ? readLearningCasesFile(learningCasesPath)
  : { path: null, cases: [] };
const learningCases = learningCasesInput.cases;
const learningCasesPerSample = scenario === "learning-cases"
  ? Math.max(1, Math.trunc(numArg(
    "learning-cases-per-sample",
    Math.ceil(learningCases.length / maxSamples),
  )))
  : 0;
const learningCaseConflictGateClassification = scenario === "learning-cases"
  ? {
      conflictAtLeast5: "NOT_APPLICABLE_TO_LEARNING_CASE_DECISION_SCENARIO",
      conflictResolvedAtLeast3: "NOT_APPLICABLE_TO_LEARNING_CASE_DECISION_SCENARIO",
      reason: "learning-cases routes generated decision cases through runtime/model prediction and oracle scoring; conflict-flood gates require explicit contradiction-review stimulus and remain blocked unless run with conflict-flood or a combined scenario",
      evidenceBoundary: "diagnostic_precheck_classification_only_not_formal_acceptance",
    }
  : null;

async function assertPortAvailable(port) {
  const ok = await new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
  if (!ok) {
    throw new Error(`PORT ${port} is already in use; stop the listening PID precisely instead of using lsof -ti tcp:${port}.`);
  }
  return port;
}

async function waitForReady(baseUrl, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      if (res.ok) return true;
      lastError = `${res.status} ${await res.text()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }
  throw new Error(`/readyz did not become ready within ${timeoutMs}ms: ${lastError}`);
}

function apiTimingSegment(method, path) {
  if (method === "POST" && /\/scheduler\/tick$/.test(path)) return "scheduler_tick";
  if (/\/api\/knowledge(?:\?|$)/.test(path) || /\/knowledge\/search/.test(path)) return "knowledge_retrieval";
  if (/\/api\/flywheel\/health|\/api\/human-gates|\/api\/projects\/[^/]+\/(?:knowledge-reviews|cycles|ops-metrics|traces|llm-calls)|\/api\/action-ledger/.test(path)) {
    return "harness_polling_api_request";
  }
  return "runner_control_api_request";
}

async function requestJson(baseUrl, path, options = {}) {
  const method = options.method || "GET";
  const maxAttempts = Math.max(1, options.attempts ?? 4);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    let timingRecorded = false;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      event("api_request_timing", {
        method,
        path,
        segment: apiTimingSegment(method, path),
        attempt,
        status: res.status,
        ok: res.ok,
        durationMs: Date.now() - started,
      });
      timingRecorded = true;
      if (res.ok) return json;
      const error = new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(json).slice(0, 800)}`);
      if (res.status < 500 && res.status !== 429) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (err) {
      if (!timingRecorded) {
        event("api_request_timing", {
          method,
          path,
          segment: apiTimingSegment(method, path),
          attempt,
          status: null,
          ok: false,
          durationMs: Date.now() - started,
        });
      }
      lastError = err;
      if (err instanceof Error && err.retryable === false) throw err;
      if (attempt >= maxAttempts) break;
    }
    event("request_retry", {
      method,
      path,
      attempt,
      maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    await sleep(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function requestText(baseUrl, path, options = {}) {
  const method = options.method || "GET";
  const maxAttempts = Math.max(1, options.attempts ?? 4);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    let timingRecorded = false;
    try {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: options.headers || {} });
      const text = await res.text();
      event("api_request_timing", {
        method,
        path,
        segment: apiTimingSegment(method, path),
        attempt,
        status: res.status,
        ok: res.ok,
        durationMs: Date.now() - started,
      });
      timingRecorded = true;
      if (res.ok) return text;
      const error = new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 800)}`);
      if (res.status < 500 && res.status !== 429) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (err) {
      if (!timingRecorded) {
        event("api_request_timing", {
          method,
          path,
          segment: apiTimingSegment(method, path),
          attempt,
          status: null,
          ok: false,
          durationMs: Date.now() - started,
        });
      }
      lastError = err;
      if (err instanceof Error && err.retryable === false) throw err;
      if (attempt >= maxAttempts) break;
    }
    event("request_retry", {
      method,
      path,
      attempt,
      maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    await sleep(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function redactEnvForRecord(env) {
  const secretKeys = /key|token|secret|password/i;
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => /^(ALAYA|OPENAI|MINIMAX|PORT|HOST|NODE_ENV|REUSE_PORT)/.test(key))
    .map(([key, value]) => [key, secretKeys.test(key) ? "[redacted]" : value]));
}

async function startLocalApp() {
  const port = baseUrlArg ? Number(new URL(baseUrlArg).port || 80) : await assertPortAvailable(requestedPort);
  const baseUrl = baseUrlArg || `http://127.0.0.1:${port}`;
  if (!startApp) {
    await waitForReady(baseUrl, 10_000);
    return { baseUrl, child: null, port };
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    REUSE_PORT: "false",
    NODE_ENV: "development",
    ALAYA_MODE: "development",
    ALAYA_DB_PATH: dbPath,
    ALAYA_AUTO_SEED_DEMO: "false",
    ALAYA_SCHEDULER: "false",
    ALAYA_SENSOR_FEEDBACK_WINDOW_MS: "0",
    ALAYA_BASE_URL: baseUrl,
    ALAYA_LLM_PROVIDER: llmProvider,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_BASE_URL: REQUIRED_OPENAI_BASE_URL,
    OPENAI_MODEL: openaiModel,
    OPENAI_API_MODE: process.env.OPENAI_API_MODE || "chat",
    OPENAI_MAX_OUTPUT_TOKENS: process.env.OPENAI_MAX_OUTPUT_TOKENS || "1024",
    OPENAI_REQUEST_TIMEOUT_MS: process.env.OPENAI_REQUEST_TIMEOUT_MS || "90000",
    OPENAI_MAX_RETRIES: process.env.OPENAI_MAX_RETRIES || "2",
    OPENAI_RETRY_BASE_MS: process.env.OPENAI_RETRY_BASE_MS || "1500",
    MINIMAX_THINKING: process.env.MINIMAX_THINKING || "disabled",
    ...(knowledgeRetrievalControlPath ? { ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH: knowledgeRetrievalControlPath } : {}),
    ALAYA_CAP_LLM_CALL: "true",
    ALAYA_CAP_KNOWLEDGE_WRITE: "true",
    ALAYA_CAP_SCHEDULER_LOOP: "true",
    ALAYA_CAP_EXTERNAL_NOTIFICATION: process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION || "false",
    ALAYA_ALLOWED_NETWORK_HOSTS: process.env.ALAYA_ALLOWED_NETWORK_HOSTS || "api.github.com,api.openai.com,api.minimax.io,api.minimaxi.com,api.telegram.org,open.feishu.cn",
    ALAYA_COST_RATE_LIMIT_MAX: process.env.ALAYA_COST_RATE_LIMIT_MAX || "10000",
  };

  event("app_starting", { baseUrl, dbPath, env: redactEnvForRecord(env) });
  const appLog = createWriteStream(appLogPath, { flags: "a" });
  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(appLog);
  child.stderr.pipe(appLog);
  child.once("exit", (code, signal) => {
    event("app_exit", { code, signal });
  });
  await waitForReady(baseUrl);
  event("app_ready", { baseUrl, pid: child.pid });
  return { baseUrl, child, port };
}

function projectPayload() {
  const description = projectDescription();
  return {
    name: PROJECT_NAME,
    oneLiner: description,
    targetUser: "匿名投研团队；个股多空研判与组合风控负责人",
    currentHypothesis: `在 ${durationTextZh} 连续验证窗口内，基本面上修、盈利下修、估值波动与事件催化会持续拉扯单边多头/单边空头/分层仓位决策；系统必须复用历史知识、隔离矛盾知识并让 Human Gate 触发率逐步收敛。`,
    neverDo: "不得把互相矛盾的多空结论同时作为 active 决策事实复用；不得绕过仓位上限、回撤预算和财报窗口风险约束。",
    redlines: [
      "遇到看多 vs 看空研判矛盾必须记录 conflict 并等待人工审核",
      "低置信度或单轮 LLM 结论不得直接晋级 strong",
      "所有仓位建议必须同时说明多空论点、风险预算、事件催化和退出条件",
    ],
    founderPreference: "优先保留风险调整后收益，但不能牺牲回撤预算、流动性约束和审计可解释性。",
    competitors: "多头基本面报告、空头事件驱动报告、量化风险模型、组合经理仓位复盘",
    feedbackSources: `Codex ${durationLabel} runner 表单反馈矛盾注入、Alaya agent outputs、Human Gate 审核`,
    weeklyHumanMinutes: 10080,
    weeklyLlmBudgetCents: 1_000_000,
    firstClaimMetric: "decision_confidence",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.7,
    firstSignal: `每轮输出当前单边多头/单边空头/分层仓位决策、置信度、关键证据和冲突记录；${durationLabel} 全程观察 delta、Human Gate、conflict resolution 和 Stall Guard。`,
  };
}

function projectConfigPatch() {
  const payload = projectPayload();
  const validationNote = [
    `${durationLabel} 验证目标:`,
    `本轮 Equity Thesis 验证窗口为 ${durationTextZh}；runner 使用 sample-minutes=${+(sampleMs / 60_000).toFixed(3)}、progress-ticks-per-sample=${progressTicksPerSample}、max-samples=${maxSamples}。`,
    "每轮必须复用当前知识库，不得只重算单轮结论；最终需要观察 delta、Human Gate 收敛、conflict resolution 和 Stall Guard 触发率。",
  ].join("\n");
  return {
    name: payload.name,
    direction: payload.oneLiner,
    targetUser: payload.targetUser,
    redlines: payload.redlines,
    weeklyHumanMinutes: payload.weeklyHumanMinutes,
    weeklyLlmBudgetCents: payload.weeklyLlmBudgetCents,
    firstClaimMetric: payload.firstClaimMetric,
    firstClaimOperator: payload.firstClaimOperator,
    firstClaimTarget: payload.firstClaimTarget,
    seedIdentity: [
      `身份:${payload.name} —— ${payload.oneLiner}`,
      `目标用户:${payload.targetUser}`,
      `创始人偏好:${payload.founderPreference}`,
      `绝不做:${payload.neverDo}`,
      `红线:${payload.redlines.join("、")}`,
      validationNote,
    ].join("\n"),
    worldModel: [
      `初始假设:${payload.currentHypothesis}`,
      `已知竞品:${payload.competitors}`,
      `反馈来源:${payload.feedbackSources}`,
      `第一轮希望看到的信号:${payload.firstSignal}`,
      `第一轮可观测指标:${payload.firstClaimMetric} ${payload.firstClaimOperator} ${payload.firstClaimTarget}`,
      validationNote,
    ].join("\n"),
  };
}

async function createProject(baseUrl) {
  const projectPath = join(logDir, "project.json");
  if (existsSync(projectPath)) {
    try {
      const existing = JSON.parse(readFileSync(projectPath, "utf8"));
      if (existing?.id) {
        if (existingRun) {
          const project = await requestJson(baseUrl, `/api/projects/${existing.id}`);
          writeFileSync(projectPath, JSON.stringify(project, null, 2));
          event("project_reused", {
            projectId: project.id,
            name: project.name,
            promptCadenceMinutes: 5,
            maxSamples,
            resumeMode: "read_only_existing_project",
            lastRecordedSample: lastRecordedSample(),
          });
          return project;
        }
        const project = await requestJson(baseUrl, `/api/projects/${existing.id}`, {
          method: "PATCH",
          body: projectConfigPatch(),
        });
        writeFileSync(projectPath, JSON.stringify(project, null, 2));
        event("project_reused", { projectId: project.id, name: project.name, promptCadenceMinutes: 5, maxSamples });
        return project;
      }
    } catch (error) {
      event("project_reuse_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (existingRun) throw error;
    }
  }
  const project = await requestJson(baseUrl, "/api/projects", {
    method: "POST",
    body: projectPayload(),
  });
  writeFileSync(projectPath, JSON.stringify(project, null, 2));
  event("project_created", { projectId: project.id, name: project.name });
  return project;
}

async function providerCanary(baseUrl, projectId) {
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/provider-canary`, {
    method: "POST",
    body: { role: "orchestrator" },
  });
  event("provider_canary", result);
  if (!result.ok) {
    issue({
      severity: "P0",
      title: "MiniMax/OpenAI-compatible provider canary failed",
      detail: `Provider canary failed before the long run. failureType=${result.llmFailureType || "unknown"}, schemaValid=${result.schemaValid}`,
      evidence: JSON.stringify({ provider: result.provider, model: result.model, latencyMs: result.latencyMs }),
    });
  }
  return result;
}

function assertValidationCanary(result) {
  const errors = [];
  if (!result.ok) errors.push(`ok=false failureType=${result.llmFailureType || "unknown"}`);
  if (result.provider !== REQUIRED_LLM_PROVIDER) errors.push(`provider=${result.provider || "unknown"}`);
  if (result.provider === "mock") errors.push("provider canary returned mock");
  if (result.model !== REQUIRED_OPENAI_MODEL) errors.push(`model=${result.model || "unknown"}`);
  if (errors.length === 0) return;

  const detail = `Provider canary must return ok=true, provider=${REQUIRED_LLM_PROVIDER}, model=${REQUIRED_OPENAI_MODEL}; got ${errors.join(", ")}.`;
  issue({
    severity: "P0",
    title: "Equity Thesis launch guard rejected provider canary",
    detail,
    evidence: JSON.stringify({
      provider: result.provider,
      model: result.model,
      ok: result.ok,
      llmFailureType: result.llmFailureType,
      schemaValid: result.schemaValid,
    }),
  });
  throw new Error(detail);
}

async function injectContradictionEvidence(baseUrl, projectId, sample) {
  const template = evidenceSchedule[(sample - 1) % evidenceSchedule.length];
  const externalId = `sample_${String(sample).padStart(4, "0")}_${template.side}`;
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/feedback/form`, {
    method: "POST",
    body: {
      sourceName: "equity-thesis-contradiction-runner",
      externalId,
      title: template.title,
      text: template.text,
      url: "",
    },
  });
  event("contradiction_feedback_injected", {
    sample,
    side: template.side,
    externalId,
    evidenceTitle: template.title,
    evidenceText: template.text,
    ...oracleEventFields(template.side),
    imported: result.imported,
    skipped: result.skipped,
    gateId: result.gate?.id ?? null,
    classification: result.classification,
  });
  return result;
}

async function injectCognitionCoverageEvidence(baseUrl, projectId, sample, ordinal) {
  const template = buildCognitionCoverageEvidence(ordinal);
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/feedback/form`, {
    method: "POST",
    body: {
      sourceName: template.sourceName,
      externalId: template.externalId,
      title: template.title,
      text: template.text,
      url: "",
    },
  });
  event("contradiction_feedback_injected", {
    sample,
    scenario,
    coverageOrdinal: ordinal,
    side: template.side,
    externalId: template.externalId,
    evidenceTitle: template.title,
    evidenceText: template.text,
    calibrationTruth: template.calibrationTruth ?? null,
    ...oracleEventFields(template.side),
    imported: result.imported,
    skipped: result.skipped,
    gateId: result.gate?.id ?? null,
    classification: result.classification,
  });
  return result;
}

async function injectCognitionCoverageBatch(baseUrl, projectId, sample, state) {
  for (let i = 0; i < cognitionCoveragePerSample; i += 1) {
    state.cognitionCoverageOrdinal += 1;
    await injectCognitionCoverageEvidence(baseUrl, projectId, sample, state.cognitionCoverageOrdinal);
  }
}

async function injectLearningCaseFeedback(baseUrl, projectId, testCase, sample, ordinal) {
  const externalId = learningCaseId(testCase);
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/feedback/form`, {
    method: "POST",
    body: {
      sourceName: "learning-case-runtime-input",
      externalId,
      title: testCase.title ?? `Learning case ${externalId}`,
      text: learningCasePrompt(testCase),
      url: "",
    },
  });
  event("learning_case_runtime_input", {
    sample,
    ordinal,
    projectId,
    caseId: externalId,
    externalId,
    worldSeed: String(testCase.worldSeed ?? ""),
    ruleId: testCase.ruleId ?? null,
    ruleRef: testCase.ruleRef ?? null,
    pool: testCase.pool ?? testCase.split ?? null,
    signalIds: Array.isArray(testCase.signalIds) ? testCase.signalIds : [],
    imported: result.imported ?? null,
    skipped: result.skipped ?? null,
    gateId: result.gate?.id ?? null,
    classification: result.classification ?? null,
    runtimePath: "api:/feedback/form",
    decisionSource: "runtime_model_prediction_pending",
  });
  return result;
}

async function configureLearningCaseProject(baseUrl, projectId, testCase, sample, ordinal) {
  const patch = learningCaseProjectPatch(testCase);
  const modelVisiblePrompt = learningCasePrompt(testCase);
  const project = await requestJson(baseUrl, `/api/projects/${projectId}`, {
    method: "PATCH",
    body: patch,
  });
  event("learning_case_project_configured", {
    sample,
    ordinal,
    projectId,
    caseId: learningCaseId(testCase),
    pool: testCase?.pool ?? testCase?.split ?? null,
    runtimePath: "api:/projects/:id PATCH",
    decisionSource: "runtime_model_prediction_context",
    directionChars: patch.direction.length,
    seedIdentityChars: patch.seedIdentity.length,
    worldModelChars: patch.worldModel.length,
    redlineCount: patch.redlines.length,
    projectIdConfirmed: project?.id ?? null,
  });
  event("learning_case_model_input_audit", {
    sample,
    ordinal,
    projectId,
    caseId: learningCaseId(testCase),
    modelVisiblePrompt,
    modelVisiblePromptChars: modelVisiblePrompt.length,
    hiddenMetadataIncluded: false,
    auditBoundary: "non_model_runtime_event",
  });
  return project;
}

async function recordLearningCaseRuntimeDecision(baseUrl, projectId, testCase, sample, ordinal, state, options = {}) {
  const caseId = learningCaseId(testCase);
  const groundTruthDecision = learningCaseGroundTruth(testCase);
  if (!caseId || !groundTruthDecision) {
    event("learning_case_unscoreable_input", {
      sample,
      ordinal,
      projectId,
      caseId: caseId || null,
      reason: !caseId ? "missing_case_id" : "missing_ground_truth_decision",
    });
    throw new Error(`learning case ${caseId || ordinal} is missing ${!caseId ? "caseId" : "groundTruthDecision"}`);
  }

  const writePolicy = heldoutWritePolicy(testCase);
  const knowledgeBefore = writePolicy.heldout
    ? await requestJson(baseUrl, `/api/knowledge?projectId=${projectId}`)
    : [];
  await configureLearningCaseProject(baseUrl, projectId, testCase, sample, ordinal);
  if (writePolicy.heldout) {
    event("learning_case_runtime_input_filtered", {
      sample,
      ordinal,
      projectId,
      caseId,
      pool: "heldout",
      signalIds: Array.isArray(testCase.signalIds) ? testCase.signalIds : [],
      excludeFromDistiller: true,
      excludeFromCreditTraining: true,
      knowledgeRetrievalMode: writePolicy.knowledgeRetrievalMode,
      blockedPaths: writePolicy.blockedPaths,
      modelVisiblePromptChars: learningCasePrompt(testCase).length,
      runtimePath: "api:/projects/:id PATCH",
      decisionSource: "runtime_model_prediction_pending",
    });
  } else {
    await injectLearningCaseFeedback(baseUrl, projectId, testCase, sample, ordinal);
  }

  const progress = await progressLearningCaseFlywheel(baseUrl, projectId, state, {
    ...options,
    evaluationOnly: writePolicy.heldout,
    caseId,
  });
  if (!progress.completed) {
    event("learning_case_cycle_incomplete", {
      sample,
      ordinal,
      projectId,
      caseId,
      pool: testCase.pool ?? testCase.split ?? null,
      schedulerTicks: progress.ticks,
    });
    throw new Error(`learning case ${caseId} did not complete its causal cycle within ${progressTicksPerSample} scheduler ticks`);
  }
  const causalCycle = causalCycleFromSchedulerTicks(progress.ticks);
  const afterPredictions = await requestJson(baseUrl, `/api/projects/${projectId}/predictions`);
  const binding = bindLearningPrediction({
    caseId,
    causalCycleId: causalCycle.cycleId,
    predictions: afterPredictions,
  });
  if (causalCycle.status !== "bound" || binding.status !== "bound") {
    const failure = {
      sample,
      ordinal,
      projectId,
      caseId,
      pool: testCase.pool ?? testCase.split ?? null,
      ruleId: testCase.ruleId ?? null,
      status: binding.status === "bound" ? causalCycle.status : binding.status,
      reason: binding.reason ?? `causal_cycle_${causalCycle.status}`,
      causalCycleIds: causalCycle.cycleIds,
      candidatePredictionIds: binding.candidatePredictionIds,
      schedulerTicks: progress.ticks,
      decisionSource: "runtime_model_prediction_binding_failed",
    };
    event("learning_case_prediction_binding_error", failure);
    throw new Error(`learning case ${caseId} prediction binding failed: ${failure.reason}`);
  }

  const prediction = binding.prediction;
  const cycleId = prediction.cycleId;
  const [traces, llmCalls] = await Promise.all([
    requestJson(baseUrl, `/api/cycles/${cycleId}/traces?limit=5000`),
    requestJson(baseUrl, `/api/projects/${projectId}/llm-calls`),
  ]);
  const injectionTrace = latestKnowledgeInjectionTrace(traces);
  const injectionAttrs = traceAttributes(injectionTrace);
  const expectedRetrievalMode = writePolicy.knowledgeRetrievalMode;
  const retrievalModeValid = Boolean(
    injectionTrace &&
    injectionAttrs.retrievalMode === expectedRetrievalMode &&
    injectionAttrs.retrievalControlCaseId === caseId &&
    injectionAttrs.retrievalControlRunId === runId &&
    injectionAttrs.retrievalControlCycleId === cycleId &&
    (writePolicy.heldout
      ? injectionAttrs.persistenceWritesAllowed === false &&
        injectionAttrs.creditEligible === false &&
        injectionAttrs.trainingEligible === false &&
        Array.isArray(injectionAttrs.injectedKnowledgeIds) &&
        injectionAttrs.injectedKnowledgeIds.length === 0
      : injectionAttrs.persistenceWritesAllowed === !injectionAttrs.injectionDisabled)
  );
  if (!retrievalModeValid) {
    event("knowledge_retrieval_mode_error", {
      projectId,
      caseId,
      cycleId,
      expectedRetrievalMode,
      observedRetrievalMode: injectionAttrs.retrievalMode ?? null,
      traceEventId: injectionTrace?.id ?? null,
    });
    throw new Error(`learning case ${caseId} retrieval mode was missing or ambiguous`);
  }
  if (injectionTrace) {
    event("knowledge_injection", {
      source: "runtime_trace_api",
      traceEventId: injectionTrace.id ?? null,
      traceId: injectionTrace.traceId ?? null,
      spanId: injectionTrace.spanId ?? null,
      projectId,
      cycleId,
      cycleIdx: injectionTrace.cycleIdx ?? null,
      kind: injectionTrace.kind ?? "knowledge_injection",
      name: injectionTrace.name ?? "build_prior_knowledge_context",
      agent: injectionTrace.agent ?? null,
      status: injectionTrace.status ?? null,
      attributes: injectionAttrs,
    });
  }

  const parsedDecision = parseRuntimePredictionContract(prediction);
  const predictedDecision = parsedDecision.decision;
  const confidence = parsedDecision.confidence;
  const predictionLlmCall = [...llmCalls].reverse().find((call) => call.cycleId === cycleId && call.agent === "orchestrator") ?? null;
  const eventLog = await requestJson(baseUrl, "/api/event-log");
  const creditAudits = eventLog.filter((audit) => {
    const after = parseJsonObject(audit?.after);
    return audit?.actor === "knowledge_credit" && audit?.op === "credit" && after.cycleId === cycleId;
  });
  const injectionMutationAudits = eventLog.filter((audit) => (
    audit?.actor === "knowledge_injection" &&
    audit?.op === "inject" &&
    Number(audit?.cycleIdx ?? audit?.cycle_idx) === Number(injectionTrace?.cycleIdx)
  ));
  const knowledgeAfter = writePolicy.heldout
    ? await requestJson(baseUrl, `/api/knowledge?projectId=${projectId}`)
    : [];
  const heldoutInvariant = writePolicy.heldout
    ? compareHeldoutKnowledgeState(knowledgeBefore, knowledgeAfter)
    : null;

  event("learning_case_prediction_bound", {
    sample,
    ordinal,
    projectId,
    caseId,
    cycleId,
    predictionId: prediction.id,
    status: binding.status,
    bindingMethod: binding.bindingMethod,
    candidatePredictionIds: binding.candidatePredictionIds,
    schedulerTicks: progress.ticks,
  });
  if (writePolicy.heldout) {
    const heldoutFilter = {
      sample,
      ordinal,
      projectId,
      caseId,
      cycleId,
      status: heldoutInvariant.passed && creditAudits.length === 0 && injectionMutationAudits.length === 0 && retrievalModeValid
        ? "applied"
        : "violation",
      excludeFromDistiller: true,
      excludeFromCreditTraining: true,
      blockedPaths: writePolicy.blockedPaths,
      knowledgeStateInvariant: heldoutInvariant,
      knowledgeRetrievalMode: injectionAttrs.retrievalMode ?? null,
      readOnlySelectedKnowledgeIds: Array.isArray(injectionAttrs.readOnlySelectedKnowledgeIds) ? injectionAttrs.readOnlySelectedKnowledgeIds : [],
      knowledgeInjectMutationEventCount: injectionMutationAudits.length,
      knowledgeCreditEventCount: creditAudits.length,
      predictionResolutionSkipped: prediction.status !== "resolved",
      auditBoundary: "non_model_runtime_event",
    };
    event("heldout_write_filter", heldoutFilter);
    if (heldoutFilter.status !== "applied") {
      throw new Error(`heldout learning case ${caseId} violated write isolation`);
    }
  } else {
    event("knowledge_credit_audit", {
      sample,
      ordinal,
      projectId,
      caseId,
      cycleId,
      predictionId: prediction.id,
      creditEventCount: creditAudits.length,
      knowledgeIds: creditAudits.map((audit) => parseJsonObject(audit.after).knowledgeId).filter(Boolean),
      comparablePayloads: creditAudits.every((audit) => Boolean(audit.before && audit.after)),
    });
  }

  const runtimePath = writePolicy.heldout
    ? "api:/projects/:id PATCH -> api:/scheduler/tick -> api:/projects/:id/predictions -> api:/cycles/:id/close"
    : "api:/feedback/form -> api:/scheduler/tick -> api:/projects/:id/predictions";
  event("learning_case_resolved", {
    learningCaseEventSchema: "alaya.learning_loop.learning_case_event.v2",
    projectId,
    arm: process.env.ALAYA_EXPERIMENT_ARM ?? "unknown",
    caseId,
    externalId: testCase.externalId ?? caseId,
    cycleId,
    cycleIdx: traces.find((trace) => trace.cycleId === cycleId)?.cycleIdx ?? null,
    predictionId: prediction.id,
    sample,
    ordinal,
    worldSeed: String(testCase.worldSeed ?? ""),
    ruleId: testCase.ruleId ?? null,
    ruleRef: testCase.ruleRef ?? null,
    pool: testCase.pool ?? testCase.split ?? null,
    predictedDecision,
    groundTruthDecision,
    expectedDecision: testCase.expectedDecision ?? groundTruthDecision,
    confidence,
    calibrationTruth: testCase.calibrationTruth ?? null,
    correctnessMode: "truth",
    excludeFromDistiller: writePolicy.excludeFromDistiller,
    excludeFromCreditTraining: writePolicy.excludeFromCreditTraining,
    decisionSource: "runtime_model_prediction",
    runtimePath,
    evidenceBoundary: "real_provider_compressed_precheck_diagnostic_only",
    binding: {
      status: binding.status,
      method: binding.bindingMethod,
      cycleId,
      predictionId: prediction.id,
    },
    modelPrediction: comparablePrediction(prediction),
    knowledgeInjection: {
      traceEventId: injectionTrace?.id ?? null,
      injectedKnowledgeIds: Array.isArray(injectionAttrs.injectedKnowledgeIds) ? injectionAttrs.injectedKnowledgeIds : [],
      readOnlySelectedKnowledgeIds: Array.isArray(injectionAttrs.readOnlySelectedKnowledgeIds) ? injectionAttrs.readOnlySelectedKnowledgeIds : [],
      candidateIds: Array.isArray(injectionAttrs.candidateIds) ? injectionAttrs.candidateIds : [],
      retrievalMode: injectionAttrs.retrievalMode ?? null,
      creditEligible: injectionAttrs.creditEligible ?? null,
      trainingEligible: injectionAttrs.trainingEligible ?? null,
      rankingMode: injectionAttrs.rankingMode ?? null,
      droppedKnowledgeId: injectionAttrs.droppedKnowledgeId ?? null,
      epsilon: injectionAttrs.epsilon ?? null,
      injectionDisabled: injectionAttrs.injectionDisabled ?? null,
    },
    llmCall: predictionLlmCall ? {
      id: predictionLlmCall.id ?? null,
      provider: predictionLlmCall.provider ?? null,
      model: predictionLlmCall.model ?? null,
      tokenSource: predictionLlmCall.tokenSource ?? null,
      schemaValid: predictionLlmCall.schemaValid ?? null,
      llmFailureType: predictionLlmCall.llmFailureType ?? null,
    } : null,
    parseStatus: parsedDecision.status === "ok" ? "ok" : `unparsed_model_decision_${parsedDecision.status}`,
    parseSourceField: parsedDecision.sourceField,
  });
  return { caseId, lastAction: progress.lastAction, parseStatus: parsedDecision.status };
}

async function recordLearningCaseBatch(baseUrl, projectId, sample, state, options = {}) {
  if (scenario !== "learning-cases") return [];
  const emitted = [];
  for (let i = 0; i < learningCasesPerSample && state.learningCaseOrdinal < learningCases.length; i += 1) {
    const caseItem = learningCases[state.learningCaseOrdinal];
    const ordinal = state.learningCaseOrdinal + 1;
    const execution = await state.learningCaseHardStop.runProvider({
      sample,
      ordinal,
      caseId: learningCaseId(caseItem),
      phase: options.finalDrain ? "final_drain" : "sample",
    }, () => recordLearningCaseRuntimeDecision(baseUrl, projectId, caseItem, sample, ordinal, state, options));
    if (execution.status === "blocked") break;
    const result = execution.value;
    emitted.push(result.caseId || learningCaseId(caseItem));
    state.lastLearningCaseAction = result.lastAction || state.lastLearningCaseAction || "";
    state.learningCaseOrdinal += 1;
  }
  if (emitted.length > 0) {
    event("learning_case_batch_recorded", {
      sample,
      projectId,
      emittedCaseIds: emitted,
      emittedCount: emitted.length,
      totalEmitted: state.learningCaseOrdinal,
      totalCases: learningCases.length,
      casesRemaining: Math.max(0, learningCases.length - state.learningCaseOrdinal),
      learningCasesPath: learningCasesInput.path,
      decisionSource: "runtime_model_prediction",
    });
  }
  return emitted;
}

function parsePayload(gate) {
  if (!gate?.payload) return {};
  if (typeof gate.payload === "object") return gate.payload;
  try {
    return JSON.parse(gate.payload);
  } catch {
    return {};
  }
}

function shouldHoldMeaningGate(gate, state, options = {}) {
  const allowSamplingHold = options.allowSamplingHold !== false;
  if (!approveMeaning) return true;
  if (scenario === "conflict-flood" && isEquityThesisContradictionGate(gate)) return false;
  const payload = parsePayload(gate);
  if (payload.riskKey === "knowledge_review_reminder") return true;
  if (holdReviewRequiredMeaning && meaningGateRequiresHumanReview(gate)) return true;
  if (allowSamplingHold && holdEveryMeaning > 0 && state.currentSample <= holdEveryMeaningUntilSample) {
    if (!state.meaningGateSequenceById.has(gate.id)) {
      state.meaningGateSequenceById.set(gate.id, state.meaningGateSequenceById.size + 1);
    }
    const sequence = state.meaningGateSequenceById.get(gate.id);
    const heldAtSample = state.heldMeaningGateSampleById.get(gate.id);
    if (heldAtSample != null) return state.currentSample <= heldAtSample;
    if (sequence % holdEveryMeaning === 0) {
      state.heldMeaningGateSampleById.set(gate.id, state.currentSample);
      return true;
    }
  }
  return false;
}

function isEquityThesisContradictionGate(gate) {
  const payload = parsePayload(gate);
  const sourceName = String(payload.sourceName ?? "");
  const externalId = String(payload.externalId ?? "");
  const userQuote = String(payload.userQuote ?? "");
  return sourceName === "equity-thesis-contradiction-runner"
    || /^sample_\d{4}_(?:long_support|short_support|long_risk|short_risk|tiered_support|tiered_reject)$/.test(externalId)
    || /equity-thesis-contradiction-runner\s+sample_\d{4}_/.test(userQuote);
}

function meaningGateRequiresHumanReview(gate) {
  const payload = parsePayload(gate);
  const userQuote = reviewableFeedbackBody(payload.userQuote);
  const text = [
    gate.title,
    payload.summary,
    payload.reason,
    payload.sampleReviewReason,
    payload.requiredAction,
    userQuote,
    payload.redactedBody,
    payload.auditSummary?.whyNow,
  ].map((item) => String(item ?? "")).join("\n");
  return /明确冲突|互相矛盾|不能同时|不能直接复用|必须进入\s*conflict|冲突审查|等待人工审核|\bcontradict(?:s|ed|ory)?\b|\bcontradiction\b(?!-runner)|conflicts?\s+with|conflict review|cannot be reused|cannot.*active/i.test(text);
}

function reviewableFeedbackBody(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/^Form Feedback \(/i.test(text)) {
    const parts = text.split(/\n\s*\n/);
    if (parts.length > 1) return parts.slice(1).join("\n\n");
    return text.replace(/^Form Feedback[^\n]*\n?/i, "");
  }
  return text;
}

async function resolvePendingGates(baseUrl, projectId, state, options = {}) {
  const gates = await requestJson(baseUrl, `/api/human-gates?projectId=${projectId}`);
  for (const gate of gates.filter((item) => item.status === "pending")) {
    const payload = parsePayload(gate);
    if (gate.type === "meaning" && shouldHoldMeaningGate(gate, state, options)) {
      event("gate_left_pending_for_sampling", { gateId: gate.id, gateType: gate.type, title: gate.title });
      continue;
    }
    if (gate.type === "risk" && payload.riskKey === "knowledge_conflict_review") {
      event("conflict_gate_left_to_review_resolver", { gateId: gate.id, reviewId: payload.reviewId });
      continue;
    }
    const rationale = [
      `Equity Thesis ${durationLabel} validation human proxy via ${decisionVia}.`,
      gate.type === "direction" ? "Approve the proposed direction so the flywheel can continue and expose compounding/conflict behavior." : "",
      gate.type === "meaning" ? "Approve injected/ambiguous evidence to materialize knowledge and test conflict isolation." : "",
      gate.type === "risk" ? "Risk gate recorded for validation; approve to continue after logging the risk." : "",
    ].filter(Boolean).join(" ");
    const updated = await requestJson(baseUrl, `/api/human-gates/${gate.id}/approve`, {
      method: "POST",
      body: { rationale },
    });
    if (!updated || updated.status === "pending") {
      event("gate_approval_not_applied", {
        gateId: gate.id,
        gateType: gate.type,
        blocking: gate.blocking,
        title: gate.title,
        via: decisionVia,
        status: updated?.status ?? "missing_response",
        payloadRiskKey: payload.riskKey ?? null,
      });
      continue;
    }
    if (gate.type === "meaning") state.approvedMeaningCount += 1;
    event("gate_approved", {
      gateId: gate.id,
      gateType: gate.type,
      blocking: gate.blocking,
      title: gate.title,
      via: decisionVia,
      status: updated.status,
      payloadRiskKey: payload.riskKey ?? null,
    });
  }
}

async function scanConflicts(baseUrl, projectId) {
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/knowledge/conflicts/scan`, {
    method: "POST",
    body: {},
  });
  event("conflicts_scanned", {
    conflictCandidateCount: result.conflicts?.length ?? 0,
    reviewRequiredCount: result.reviews?.length ?? 0,
  });
  return result;
}

function isSeedConflictReview(review) {
  const left = String(review.primaryKnowledgeId ?? "");
  const right = String(review.relatedKnowledgeId ?? "");
  return left.startsWith("kb_seed_") && right.startsWith("kb_seed_");
}

function shouldHoldConflictResolution(state) {
  return scenario === "conflict-flood" && state.currentSample <= conflictFloodHoldSamples;
}

function oracleDisposition(side) {
  return oracleMetadataForSide(side)?.expectedDisposition ?? "";
}

function sideShouldBeRetained(side) {
  return /^retained/.test(oracleDisposition(side));
}

function sideShouldBeRemoved(side) {
  return /superseded|quarantined|deprecated/.test(oracleDisposition(side));
}

function resolutionBodyForAction(review, action) {
  if (action === "merge_supersede" && review.relatedKnowledgeId) {
    return {
      action,
      survivorKnowledgeId: review.relatedKnowledgeId,
      rationale: `Equity Thesis validation human proxy via ${decisionVia}: merge duplicate/conflicting evidence by preserving the oracle-selected survivor.`,
    };
  }
  if (action === "approve_as_current" || action === "reject_conflict") {
    return {
      action,
      rationale: `Equity Thesis validation human proxy via ${decisionVia}: retain the primary item because the independent oracle expects this side to remain reusable.`,
    };
  }
  return {
    action: "quarantine",
    rationale: `Equity Thesis validation human proxy via ${decisionVia}: quarantine the primary item because the independent oracle expects the other side to remain reusable.`,
  };
}

function plannedConflictResolution(review, primaryOracleSide, relatedOracleSide) {
  const candidateActions = [
    "approve_as_current",
    "quarantine",
    "merge_supersede",
  ];
  const candidates = candidateActions
    .filter((action) => action !== "merge_supersede" || review.relatedKnowledgeId)
    .map((action) => {
      const body = resolutionBodyForAction(review, action);
      const score = scoreResolutionEvent({
        reviewId: review.id,
        primaryKnowledgeId: review.primaryKnowledgeId,
        relatedKnowledgeId: review.relatedKnowledgeId,
        primaryOracleSide,
        relatedOracleSide,
        action: body.action,
        survivorKnowledgeId: body.survivorKnowledgeId ?? null,
      });
      return { body, score };
    });
  const scoreableCorrect = candidates.find((candidate) => candidate.score.resolutionScoreable && candidate.score.resolutionCorrect);
  if (scoreableCorrect) {
    return {
      body: scoreableCorrect.body,
      score: scoreableCorrect.score,
      postQuarantineRelated: scoreableCorrect.body.action === "approve_as_current" && sideShouldBeRemoved(relatedOracleSide),
      planReason: "scoreable_oracle_expected_winner",
    };
  }

  const primaryRetained = sideShouldBeRetained(primaryOracleSide);
  const relatedRetained = sideShouldBeRetained(relatedOracleSide);
  const primaryRemoved = sideShouldBeRemoved(primaryOracleSide);
  const relatedRemoved = sideShouldBeRemoved(relatedOracleSide);
  let body = null;
  let postQuarantineRelated = false;
  let planReason = "fallback_conservative_quarantine";
  if (primaryRetained && !relatedRetained) {
    body = resolutionBodyForAction(review, "approve_as_current");
    postQuarantineRelated = relatedRemoved;
    planReason = "expected_disposition_retain_primary";
  } else if (relatedRetained && !primaryRetained) {
    body = resolutionBodyForAction(review, "quarantine");
    planReason = "expected_disposition_retain_related";
  } else if (primaryRemoved && relatedRemoved) {
    body = resolutionBodyForAction(review, "quarantine");
    postQuarantineRelated = Boolean(review.relatedKnowledgeId);
    planReason = "expected_disposition_remove_both_nonfinal_sides";
  } else {
    const action = primaryOracleSide && relatedOracleSide && primaryOracleSide === relatedOracleSide
      ? "merge_supersede"
      : "quarantine";
    body = resolutionBodyForAction(review, action);
  }

  const score = scoreResolutionEvent({
    reviewId: review.id,
    primaryKnowledgeId: review.primaryKnowledgeId,
    relatedKnowledgeId: review.relatedKnowledgeId,
    primaryOracleSide,
    relatedOracleSide,
    action: body.action,
    survivorKnowledgeId: body.survivorKnowledgeId ?? null,
  });
  return { body, score, postQuarantineRelated, planReason };
}

async function resolveConflictReviews(baseUrl, projectId, state, options = {}) {
  if (state.resolvedConflictReviews >= resolveConflictReviewsTarget) return 0;
  const maxResolutions = Number.isFinite(options.maxResolutions)
    ? Math.max(0, Math.trunc(options.maxResolutions))
    : Number.POSITIVE_INFINITY;
  if (maxResolutions === 0) return 0;
  let resolvedThisCall = 0;
  const reviews = await requestJson(baseUrl, `/api/projects/${projectId}/knowledge-reviews`);
  const pending = reviews.filter((review) => review.reviewType === "conflict" && review.status === "review_required");
  for (const review of pending) {
    if (state.resolvedConflictReviews >= resolveConflictReviewsTarget) break;
    if (resolvedThisCall >= maxResolutions) break;
    if (isSeedConflictReview(review) && !state.seedConflictFalsePositiveRecorded) {
      state.seedConflictFalsePositiveRecorded = true;
      issue({
        severity: "P1",
        title: "conflict detector false-positive on onboarding seed records",
        detail: "The project brief intentionally contains words such as 明确冲突/互相矛盾. The current explicit marker detector scans seed identity/world-model text and can mark the two onboarding seed records as conflicting with each other before any substantive evidence conflict exists.",
        evidence: JSON.stringify({
          reviewId: review.id,
          primaryKnowledgeId: review.primaryKnowledgeId,
          relatedKnowledgeId: review.relatedKnowledgeId,
          reason: review.reason,
        }),
      });
    }
    const primaryOracleSide = inferOracleSideFromValue(review.primaryKnowledgeId);
    const relatedOracleSide = inferOracleSideFromValue(review.relatedKnowledgeId);
    const resolutionPlan = plannedConflictResolution(review, primaryOracleSide, relatedOracleSide);
    const body = resolutionPlan.body;
    const resolutionScore = resolutionPlan.score;
    const resolved = await requestJson(baseUrl, `/api/knowledge-reviews/${review.id}/resolve`, {
      method: "POST",
      body,
    });
    if (resolutionPlan.postQuarantineRelated && review.relatedKnowledgeId) {
      await requestJson(baseUrl, `/api/knowledge/${review.relatedKnowledgeId}/quarantine`, {
        method: "POST",
        body: {
          rationale: `Equity Thesis validation human proxy via ${decisionVia}: quarantine related non-final oracle side after retaining the primary winner.`,
        },
      });
      event("knowledge_review_related_quarantined", {
        reviewId: review.id,
        relatedKnowledgeId: review.relatedKnowledgeId,
        relatedOracleSide,
        planReason: resolutionPlan.planReason,
        via: decisionVia,
      });
    }
    state.resolvedConflictReviews += 1;
    resolvedThisCall += 1;
    event("knowledge_review_resolved", {
      reviewId: review.id,
      primaryKnowledgeId: review.primaryKnowledgeId,
      relatedKnowledgeId: review.relatedKnowledgeId,
      primaryOracleSide,
      relatedOracleSide,
      oracleSide: primaryOracleSide,
      action: body.action,
      survivorKnowledgeId: body.survivorKnowledgeId ?? null,
      ...resolutionScore,
      status: resolved.status,
      via: decisionVia,
      planReason: resolutionPlan.planReason,
      postQuarantineRelated: Boolean(resolutionPlan.postQuarantineRelated),
    });
  }
  return resolvedThisCall;
}

async function progressFlywheel(baseUrl, projectId, state, options = {}) {
  let lastAction = "";
  let conflictResolutionsThisSample = 0;
  for (let i = 0; i < progressTicksPerSample; i += 1) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      event("scheduler_tick_skipped_after_deadline", {
        tickIndex: i + 1,
        deadlineAt: new Date(options.deadlineAt).toISOString(),
      });
      break;
    }
    const tick = await requestJson(baseUrl, `/api/projects/${projectId}/scheduler/tick`, {
      method: "POST",
      body: { syncFeedback: false },
    });
    lastAction = tick.action;
    event("scheduler_tick", { action: tick.action, note: tick.note, cycleId: tick.cycleId ?? null });
    await resolvePendingGates(baseUrl, projectId, state);
    await scanConflicts(baseUrl, projectId);
    if (shouldHoldConflictResolution(state)) {
      if (!state.conflictFloodHeldSamples.has(state.currentSample)) {
        state.conflictFloodHeldSamples.add(state.currentSample);
        event("conflict_flood_resolution_held", {
          sample: state.currentSample,
          holdUntilSample: conflictFloodHoldSamples,
          scenario,
        });
      }
    } else {
      const remaining = Number.isFinite(conflictFloodMaxResolutionsPerSample)
        ? Math.max(0, conflictFloodMaxResolutionsPerSample - conflictResolutionsThisSample)
        : Number.POSITIVE_INFINITY;
      const resolved = await resolveConflictReviews(baseUrl, projectId, state, { maxResolutions: remaining });
      conflictResolutionsThisSample += resolved;
    }
    if (tick.action === "ran_operational_stages" || tick.action === "created_next_cycle") continue;
    if (tick.action === "scenario_exhausted") break;
  }
  return lastAction;
}

async function approveLearningDirectionGateOnly(baseUrl, projectId, cycleId) {
  const gates = await requestJson(baseUrl, `/api/human-gates?projectId=${projectId}`);
  const matches = gates.filter((gate) => gate.status === "pending" && gate.type === "direction" && gate.cycleId === cycleId);
  if (matches.length !== 1) {
    throw new Error(`expected one pending direction gate for heldout cycle ${cycleId}; found ${matches.length}`);
  }
  const gate = matches[0];
  const updated = await requestJson(baseUrl, `/api/human-gates/${gate.id}/approve`, {
    method: "POST",
    body: {
      rationale: "Evaluation-only heldout cycle: record the model decision, then close without operational learning stages.",
    },
  });
  if (!updated || updated.status === "pending") {
    throw new Error(`heldout direction gate ${gate.id} was not resolved`);
  }
  event("heldout_direction_gate_approved", {
    projectId,
    cycleId,
    gateId: gate.id,
    status: updated.status,
    via: decisionVia,
  });
  return updated;
}

async function progressLearningCaseFlywheel(baseUrl, projectId, state, options = {}) {
  const ticks = [];
  let lastAction = "";
  let causalCycleId = null;
  let conflictResolutionsThisSample = 0;
  for (let i = 0; i < progressTicksPerSample; i += 1) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      event("learning_case_scheduler_tick_skipped_after_deadline", {
        caseId: options.caseId ?? null,
        tickIndex: i + 1,
        deadlineAt: new Date(options.deadlineAt).toISOString(),
      });
      break;
    }
    const tick = await requestLearningSchedulerTick(baseUrl, projectId, {
      caseId: options.caseId,
      mode: options.evaluationOnly ? "read_only" : "mutating",
    });
    const tickRecord = {
      action: tick.action,
      cycleId: tick.cycleId ?? null,
      nextCycleId: tick.nextCycleId ?? null,
    };
    ticks.push(tickRecord);
    lastAction = tick.action;
    event("scheduler_tick", { ...tickRecord, note: tick.note, learningCaseId: options.caseId ?? null });

    if (tick.action === "opened_direction_gate") {
      if (causalCycleId && causalCycleId !== tick.cycleId) {
        event("learning_case_causal_cycle_ambiguous", {
          caseId: options.caseId ?? null,
          firstCycleId: causalCycleId,
          secondCycleId: tick.cycleId ?? null,
          ticks,
        });
        break;
      }
      causalCycleId = tick.cycleId ?? null;
      if (options.evaluationOnly) {
        if (!causalCycleId) throw new Error(`heldout learning case ${options.caseId ?? "unknown"} opened a direction gate without cycleId`);
        await approveLearningDirectionGateOnly(baseUrl, projectId, causalCycleId);
        const closed = await requestJson(baseUrl, `/api/cycles/${causalCycleId}/close`, { method: "POST", body: {} });
        if (closed?.status !== "closed") throw new Error(`heldout cycle ${causalCycleId} did not close cleanly`);
        event("heldout_cycle_closed_without_training", {
          projectId,
          caseId: options.caseId ?? null,
          cycleId: causalCycleId,
          status: closed.status,
          skippedStages: ["sensor", "builder", "distiller", "librarian", "prediction_resolution", "knowledge_credit"],
        });
        return { lastAction: "heldout_evaluation_cycle_closed", ticks, causalCycleId, completed: true };
      }
    }

    await resolvePendingGates(baseUrl, projectId, state);
    await scanConflicts(baseUrl, projectId);
    if (shouldHoldConflictResolution(state)) {
      if (!state.conflictFloodHeldSamples.has(state.currentSample)) {
        state.conflictFloodHeldSamples.add(state.currentSample);
        event("conflict_flood_resolution_held", {
          sample: state.currentSample,
          holdUntilSample: conflictFloodHoldSamples,
          scenario,
        });
      }
    } else {
      const remaining = Number.isFinite(conflictFloodMaxResolutionsPerSample)
        ? Math.max(0, conflictFloodMaxResolutionsPerSample - conflictResolutionsThisSample)
        : Number.POSITIVE_INFINITY;
      const resolved = await resolveConflictReviews(baseUrl, projectId, state, { maxResolutions: remaining });
      conflictResolutionsThisSample += resolved;
    }

    if (causalCycleId && tick.action === "ran_operational_stages" && tick.cycleId === causalCycleId) {
      return { lastAction, ticks, causalCycleId, completed: true };
    }
    if (tick.action === "scenario_exhausted") break;
  }
  return { lastAction, ticks, causalCycleId, completed: false };
}

async function tickLearningWarmupOnce(baseUrl, projectId, state, options = {}) {
  if (options.deadlineAt && Date.now() >= options.deadlineAt) {
    event("learning_case_warmup_skipped_after_deadline", {
      deadlineAt: new Date(options.deadlineAt).toISOString(),
    });
    return { action: "deadline" };
  }
  const tick = await requestLearningSchedulerTick(baseUrl, projectId, {
    caseId: "__learning_warmup__",
    mode: "mutating",
  });
  event("learning_case_warmup_tick", {
    action: tick.action,
    note: tick.note,
    cycleId: tick.cycleId ?? null,
    nextCycleId: tick.nextCycleId ?? null,
  });
  await resolvePendingGates(baseUrl, projectId, state, { allowSamplingHold: false });
  await scanConflicts(baseUrl, projectId);
  await resolveConflictReviews(baseUrl, projectId, state);
  return tick;
}

async function warmUpLearningCaseAutonomousCycle(baseUrl, projectId, state, options = {}) {
  if (scenario !== "learning-cases" || state.learningCaseOrdinal > 0) return { status: "not_needed" };
  event("learning_case_autonomous_warmup_started", {
    projectId,
    targetOpenCycleIdx: 5,
    reason: "skip fixed scripted scenario cycles before generated learning-case scoring",
  });
  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const cycles = await requestJson(baseUrl, `/api/projects/${projectId}/cycles`);
    const open = cycles.find((cycle) => cycle.status !== "closed") ?? null;
    const maxIdx = Math.max(0, ...cycles.map((cycle) => Number(cycle.idx) || 0));
    if (open && Number(open.idx) >= 5) {
      const result = {
        status: "complete",
        attempts: attempt - 1,
        openCycleId: open.id,
        openCycleIdx: open.idx,
        maxCycleIdx: maxIdx,
      };
      event("learning_case_autonomous_warmup_complete", result);
      return result;
    }
    const tick = await tickLearningWarmupOnce(baseUrl, projectId, state, options);
    if (tick.action === "deadline") break;
  }
  const cycles = await requestJson(baseUrl, `/api/projects/${projectId}/cycles`);
  const open = cycles.find((cycle) => cycle.status !== "closed") ?? null;
  const result = {
    status: "blocked",
    openCycleId: open?.id ?? null,
    openCycleIdx: open?.idx ?? null,
    maxCycleIdx: Math.max(0, ...cycles.map((cycle) => Number(cycle.idx) || 0)),
  };
  event("learning_case_autonomous_warmup_blocked", result);
  issue({
    severity: "P1",
    title: "Learning-case autonomous warmup did not reach cycle 5",
    detail: JSON.stringify(result),
    evidence: "learning_case_autonomous_warmup_blocked",
  });
  return result;
}

async function isolateLearningWarmupKnowledge(baseUrl, projectId) {
  if (scenario !== "learning-cases") return { status: "not_needed", deprecatedCount: 0 };
  const knowledge = await requestJson(baseUrl, `/api/knowledge?projectId=${projectId}`);
  const targets = knowledge.filter((item) => ["active", "strong"].includes(item.status));
  const deprecatedIds = [];
  for (const item of targets) {
    const updated = await requestJson(baseUrl, `/api/knowledge/${item.id}`, {
      method: "PATCH",
      body: {
        status: "deprecated",
        notes: "Deprecated by learning-cases diagnostic harness to isolate fixed warmup scaffold knowledge from generated case scoring.",
      },
    });
    deprecatedIds.push(updated?.id ?? item.id);
  }
  const result = {
    status: "complete",
    deprecatedCount: deprecatedIds.length,
    deprecatedIds,
  };
  event("learning_case_warmup_knowledge_isolated", result);
  return result;
}

async function finalDrainState(baseUrl, projectId) {
  const [gates, reviews, cycles] = await Promise.all([
    requestJson(baseUrl, `/api/human-gates?projectId=${projectId}`),
    requestJson(baseUrl, `/api/projects/${projectId}/knowledge-reviews`),
    requestJson(baseUrl, `/api/projects/${projectId}/cycles`),
  ]);
  return {
    pendingGates: gates.filter((gate) => gate.status === "pending"),
    pendingConflictReviews: reviews.filter((review) => review.reviewType === "conflict" && review.status === "review_required"),
    openCycles: cycles.filter((cycle) => cycle.status !== "closed"),
  };
}

async function drainRemainingLearningCases(baseUrl, projectId, state) {
  if (scenario !== "learning-cases") {
    return { status: "not_applicable", totalCases: 0, emittedCases: 0, queuedCaseCount: 0, hardFailure: null, attempts: 0 };
  }
  const latchedFailure = state.learningCaseHardStop.snapshot();
  if (latchedFailure) {
    const result = {
      ...learningQueueDrainStatus({
        totalCases: learningCases.length,
        emittedCases: state.learningCaseOrdinal,
        hardFailure: `learning_case_hard_stop:${latchedFailure.reason}`,
      }),
      attempts: 0,
      latchedFailure,
    };
    event("learning_case_queue_drain_blocked_by_hard_stop", result);
    event("learning_case_queue_drain_failed", result);
    issue({
      severity: "P0",
      title: "Learning-case final drain blocked by latched failure",
      detail: JSON.stringify(result),
      evidence: "learning_case_queue_drain_blocked_by_hard_stop",
    });
    return result;
  }
  let attempts = 0;
  let hardFailure = null;
  while (state.learningCaseOrdinal < learningCases.length) {
    attempts += 1;
    const before = state.learningCaseOrdinal;
    try {
      const drainSample = Math.max(state.currentSample, maxSamples) + attempts;
      await recordLearningCaseBatch(baseUrl, projectId, drainSample, state, { finalDrain: true });
      if (state.learningCaseOrdinal <= before) {
        hardFailure = "learning_case_queue_made_no_progress";
        break;
      }
      event("learning_case_queue_drain_progress", {
        attempt: attempts,
        emittedThisAttempt: state.learningCaseOrdinal - before,
        totalEmitted: state.learningCaseOrdinal,
        totalCases: learningCases.length,
        queuedCaseCount: learningCases.length - state.learningCaseOrdinal,
      });
    } catch (error) {
      hardFailure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const result = {
    ...learningQueueDrainStatus({
      totalCases: learningCases.length,
      emittedCases: state.learningCaseOrdinal,
      hardFailure: state.learningCaseHardStop.isLatched()
        ? `learning_case_hard_stop:${state.learningCaseHardStop.snapshot().reason}`
        : hardFailure,
    }),
    attempts,
    latchedFailure: state.learningCaseHardStop.snapshot(),
  };
  event(result.status === "complete" ? "learning_case_queue_drain_complete" : "learning_case_queue_drain_failed", result);
  if (result.status !== "complete") {
    issue({
      severity: "P0",
      title: "Learning-case final drain left queued cases",
      detail: JSON.stringify(result),
      evidence: "learning_case_queue_drain_failed",
    });
  }
  return result;
}

async function finalDrainFlywheel(baseUrl, projectId, state) {
  const latchedFailure = scenario === "learning-cases" ? state.learningCaseHardStop.snapshot() : null;
  if (latchedFailure) {
    const result = {
      status: "incomplete",
      attempts: 0,
      lastAction: state.lastLearningCaseAction || "",
      hardFailure: `learning_case_hard_stop:${latchedFailure.reason}`,
      latchedFailure,
    };
    event("final_drain_blocked_by_learning_case_hard_stop", result);
    return result;
  }
  const maxDrainTicks = 3;
  let lastAction = "";
  for (let attempt = 1; attempt <= maxDrainTicks; attempt += 1) {
    await resolvePendingGates(baseUrl, projectId, state, { allowSamplingHold: false });
    await scanConflicts(baseUrl, projectId);
    await resolveConflictReviews(baseUrl, projectId, state);

    const before = await finalDrainState(baseUrl, projectId);
    if (before.pendingGates.length > 0 || before.pendingConflictReviews.length > 0) {
      const result = {
        status: "blocked",
        attempts: attempt - 1,
        lastAction,
        pendingGateCount: before.pendingGates.length,
        pendingConflictReviewCount: before.pendingConflictReviews.length,
        openCycleCount: before.openCycles.length,
      };
      event("final_drain_blocked", result);
      return result;
    }
    if (before.openCycles.length === 0) {
      const result = { status: "complete", attempts: attempt - 1, lastAction };
      event("final_drain_complete", result);
      return result;
    }

    let tick;
    if (scenario === "learning-cases") {
      try {
        const execution = await state.learningCaseHardStop.runProvider({
          sample: state.currentSample,
          ordinal: state.learningCaseOrdinal + 1,
          caseId: "__final_drain__",
          phase: "flywheel_final_drain",
        }, () => requestLearningSchedulerTick(baseUrl, projectId, { caseId: "__final_drain__", mode: "mutating" }));
        if (execution.status === "blocked") {
          const failure = execution.failure;
          const result = {
            status: "incomplete",
            attempts: attempt - 1,
            lastAction,
            hardFailure: `learning_case_hard_stop:${failure.reason}`,
            latchedFailure: failure,
          };
          event("final_drain_blocked_by_learning_case_hard_stop", result);
          return result;
        }
        tick = execution.value;
      } catch (error) {
        const failure = state.learningCaseHardStop.snapshot();
        const result = {
          status: "incomplete",
          attempts: attempt - 1,
          lastAction,
          hardFailure: `learning_case_hard_stop:${failure?.reason ?? (error instanceof Error ? error.message : String(error))}`,
          latchedFailure: failure,
        };
        event("final_drain_blocked_by_learning_case_hard_stop", result);
        return result;
      }
    } else {
      tick = await requestJson(baseUrl, `/api/projects/${projectId}/scheduler/tick`, {
        method: "POST",
        body: { syncFeedback: false },
      });
    }
    lastAction = tick.action;
    event("final_drain_scheduler_tick", {
      attempt,
      action: tick.action,
      note: tick.note,
      cycleId: tick.cycleId ?? null,
      openCycleCountBeforeTick: before.openCycles.length,
    });
    if (tick.action === "scenario_exhausted" || tick.action === "waiting_blocking_gate") break;
  }

  const after = await finalDrainState(baseUrl, projectId);
  const result = {
    status: after.openCycles.length === 0 && after.pendingGates.length === 0 && after.pendingConflictReviews.length === 0 ? "complete" : "incomplete",
    attempts: maxDrainTicks,
    lastAction,
    pendingGateCount: after.pendingGates.length,
    pendingConflictReviewCount: after.pendingConflictReviews.length,
    openCycleCount: after.openCycles.length,
  };
  event("final_drain_finished", result);
  return result;
}

function countStallGuard(gates, traces, actionLedger) {
  const riskKeys = new Set(["evolution_stalled", "goal_repetition", "maturation_stall", "knowledge_explosion"]);
  const gateIds = new Set();
  for (const gate of gates) {
    const payload = parsePayload(gate);
    if (riskKeys.has(String(payload.riskKey ?? ""))) gateIds.add(gate.id);
  }
  for (const action of actionLedger) {
    const payload = parsePayload(action.payload ?? action.auditSummary ?? "{}");
    const gateId = payload.gateId ?? payload.approvalGateId ?? action.approvalGateId ?? action.target;
    const riskKey = payload.riskKey ?? payload.evidence?.riskKey;
    if (riskKeys.has(String(riskKey ?? "")) && gateId) gateIds.add(String(gateId));
  }
  return gateIds.size;
}

function appRssMb(pid) {
  if (!pid) return "";
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const kb = Number(out);
    return Number.isFinite(kb) ? +(kb / 1024).toFixed(1) : "";
  } catch {
    return "";
  }
}

function countNewGatesThisHour(gates, now = Date.now()) {
  const oneHourAgo = now - 3_600_000;
  return gates.filter((gate) => {
    const createdAt = Date.parse(String(gate.createdAt ?? ""));
    return Number.isFinite(createdAt) && createdAt >= oneHourAgo && createdAt <= now;
  }).length;
}

function llmTokenSourceStats(calls) {
  const total = calls.length;
  const provider = calls.filter((call) => call.tokenSource === "provider").length;
  const estimated = calls.filter((call) => call.tokenSource === "estimated").length;
  const providerRatio = total > 0 ? +(provider / total).toFixed(4) : null;
  let label = "none";
  if (total > 0 && provider === total) label = "provider";
  else if (total > 0 && estimated === total) label = "estimated";
  else if (total > 0) label = `mixed_provider_${Math.round((providerRatio ?? 0) * 100)}pct`;
  return { total, provider, estimated, providerRatio, label };
}

function responseItems(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

async function collectMetrics(baseUrl, projectId, appPid, sample, lastAction) {
  const [health, gateResponse, knowledgeResponse, reviews, cycles, ops, traces, actionLedger, llmCalls] = await Promise.all([
    requestJson(baseUrl, `/api/flywheel/health?projectId=${projectId}`),
    requestJson(baseUrl, `/api/human-gates?projectId=${projectId}&summary=true`),
    requestJson(baseUrl, `/api/knowledge?projectId=${projectId}&summary=true`),
    requestJson(baseUrl, `/api/projects/${projectId}/knowledge-reviews`),
    requestJson(baseUrl, `/api/projects/${projectId}/cycles`),
    requestJson(baseUrl, `/api/projects/${projectId}/ops-metrics`),
    requestJson(baseUrl, `/api/projects/${projectId}/traces?limit=5000`),
    requestJson(baseUrl, `/api/action-ledger?projectId=${projectId}&limit=5000`),
    requestJson(baseUrl, `/api/projects/${projectId}/llm-calls`),
  ]);
  const gates = responseItems(gateResponse);
  const knowledge = responseItems(knowledgeResponse);
  const pending = gates.filter((gate) => gate.status === "pending");
  const openConflictReviews = reviews.filter((review) => review.reviewType === "conflict" && review.status === "review_required").length;
  const resolvedConflictReviews = reviews.filter((review) => review.reviewType === "conflict" && review.status === "resolved").length;
  const tokenSource = llmTokenSourceStats(llmCalls);
  const row = {
    sample,
    epoch: Math.floor(Date.now() / 1000),
    iso: new Date().toISOString(),
    round1vs4KnowledgeDelta: health.compoundingProof?.round1vs4KnowledgeDelta ?? "",
    round1vsCurrentKnowledgeDelta: health.compoundingProof?.round1vsCurrentKnowledgeDelta ?? "",
    pendingGates: pending.length,
    knowledgeCount: knowledge.length,
    activeCount: health.totals?.activeKnowledgeCount ?? knowledge.filter((item) => item.status === "active").length,
    conflictCount: knowledge.filter((item) => item.status === "conflict").length,
    strongCount: knowledge.filter((item) => item.status === "strong").length,
    quarantinedCount: knowledge.filter((item) => item.status === "quarantined").length,
    deprecatedCount: knowledge.filter((item) => item.status === "deprecated").length,
    totalGates: gates.length,
    directionPending: pending.filter((gate) => gate.type === "direction").length,
    meaningPending: pending.filter((gate) => gate.type === "meaning").length,
    riskPending: pending.filter((gate) => gate.type === "risk").length,
    openConflictReviews,
    resolvedConflictReviews,
    stallGuardCount: countStallGuard(gates, traces, actionLedger),
    cyclesTotal: cycles.length,
    cyclesClosed: cycles.filter((cycle) => cycle.status === "closed").length,
    newGatesThisHour: countNewGatesThisHour(gates),
    llmTokenSource: tokenSource.label,
    llmEstimatedCostUsd: ops.llmCostPerCycle?.totalCostUsd ?? "",
    appRssMb: appRssMb(appPid),
    lastSchedulerAction: lastAction || "",
    lastDecisionVia: decisionVia,
  };
  appendFileSync(monitorCsv, Object.values(row).map((value) => String(value).replaceAll(",", ";")).join(",") + "\n");
  event("metrics_sample", { ...row, llmTokenSourceStats: tokenSource });
  return { row, health, gates, knowledge, reviews, cycles, ops, llmCalls };
}

function recordQualityCanary(sample, knowledge, state) {
  const activeKnowledge = responseItems(knowledge).filter((item) => ["active", "strong"].includes(String(item.status)));
  const decisionTsr = evaluateDecisionTsr(activeKnowledge);
  const current = {
    sample,
    status: decisionTsr.status,
    passed: decisionTsr.passed,
    tieredThesisCount: decisionTsr.tieredThesisCount,
    disallowedFinalCount: decisionTsr.disallowedFinalCount,
    eligibleKnowledgeCount: decisionTsr.eligibleKnowledgeCount,
  };
  if (!state.qualityCanaryBaseline) {
    state.qualityCanaryBaseline = current;
    event("quality_canary", {
      sample,
      expectedDecision: decisionTsr.expectedDecision,
      baseline: true,
      decisionTsr,
      driftFromBaseline: null,
      note: "Baseline canary snapshot; later canaries compare against this single-run baseline.",
    });
    return;
  }
  event("quality_canary", {
    sample,
    expectedDecision: decisionTsr.expectedDecision,
    baseline: false,
    decisionTsr,
    driftFromBaseline: {
      baselineSample: state.qualityCanaryBaseline.sample,
      passedChanged: state.qualityCanaryBaseline.passed !== current.passed,
      tieredThesisDelta: current.tieredThesisCount - state.qualityCanaryBaseline.tieredThesisCount,
      disallowedFinalDelta: current.disallowedFinalCount - state.qualityCanaryBaseline.disallowedFinalCount,
      eligibleKnowledgeDelta: current.eligibleKnowledgeCount - state.qualityCanaryBaseline.eligibleKnowledgeCount,
    },
  });
}

function opsTrendWarningLines(ops) {
  const lines = [];
  const gray = ops?.grayActiveStockTrend;
  if (gray?.warning) {
    const increases = Array.isArray(gray.increases)
      ? gray.increases.map((item) => `${item.fromCycleIdx}->${item.toCycleIdx} +${item.delta}`).join(", ")
      : "";
    lines.push(`灰区存量趋势告警：未单调下降（${increases}）`);
  }
  const budget = ops?.meaningGateBudget;
  if (budget?.overBudget) {
    lines.push(`意义闸预算告警：预计 ${budget.projectedMinutes}/${budget.budget} 分钟（pending ${budget.pendingEstimatedMinutes}）。`);
  }
  return lines;
}

async function writeMetricsSnapshot(baseUrl, projectId, sample, index, reason = "interval") {
  mkdirSync(metricsDir, { recursive: true });
  const [prometheus, json, ops] = await Promise.all([
    requestText(baseUrl, "/metrics"),
    requestJson(baseUrl, "/metrics?format=json"),
    requestJson(baseUrl, `/api/projects/${projectId}/ops-metrics`),
  ]);
  const prefix = `snapshot_${String(index).padStart(4, "0")}`;
  const meta = {
    sample,
    index,
    reason,
    capturedAt: new Date().toISOString(),
    projectId,
  };
  writeFileSync(join(metricsDir, `${prefix}.txt`), [
    `# shadow_snapshot_meta ${JSON.stringify(meta)}`,
    prometheus.trimEnd(),
    "",
  ].join("\n"));
  writeFileSync(join(metricsDir, `${prefix}.json`), `${JSON.stringify({ ...meta, metrics: json, opsMetrics: ops }, null, 2)}\n`);
  const warnings = opsTrendWarningLines(ops);
  appendFileSync(opsTrendWarningsPath, `${JSON.stringify({ ...meta, warnings })}\n`);
  event("metrics_snapshot_captured", {
    ...meta,
    files: {
      prometheus: join(metricsDir, `${prefix}.txt`),
      json: join(metricsDir, `${prefix}.json`),
    },
    warningCount: warnings.length,
    warnings,
  });
}

async function dbWritable(dbFile) {
  try {
    const imported = await import("better-sqlite3");
    const Database = imported.default;
    const db = new Database(dbFile);
    try {
      db.pragma("quick_check");
      db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runWatchdog(baseUrl, child, sample) {
  const checks = {
    sample,
    checkedAt: new Date().toISOString(),
    processAlive: !child || child.exitCode == null,
    readyz: false,
    dbWritable: false,
    diskFreeBytes: null,
    ok: false,
    errors: [],
  };
  try {
    const ready = await requestJson(baseUrl, "/readyz", { attempts: 1 });
    checks.readyz = ready?.status === "ready";
    if (!checks.readyz) checks.errors.push(`readyz=${JSON.stringify(ready).slice(0, 200)}`);
  } catch (error) {
    checks.errors.push(`readyz_error=${error instanceof Error ? error.message : String(error)}`);
  }
  const dbCheck = await dbWritable(dbPath);
  checks.dbWritable = dbCheck.ok;
  if (!dbCheck.ok) checks.errors.push(`db_writable_error=${dbCheck.error}`);
  try {
    const stat = statfsSync(logDir);
    checks.diskFreeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (checks.diskFreeBytes < 2_000_000_000) checks.errors.push(`low_disk_free_bytes=${checks.diskFreeBytes}`);
  } catch (error) {
    checks.errors.push(`disk_error=${error instanceof Error ? error.message : String(error)}`);
  }
  if (!checks.processAlive) checks.errors.push("app_process_not_alive");
  checks.ok = checks.errors.length === 0;
  appendFileSync(watchdogPath, `${JSON.stringify(checks)}\n`);
  event("watchdog_check", checks);
  if (!checks.ok) {
    issue({
      severity: "P0",
      title: `watchdog failed at sample ${sample}`,
      detail: checks.errors.join("\n"),
      evidence: JSON.stringify({
        processAlive: checks.processAlive,
        readyz: checks.readyz,
        dbWritable: checks.dbWritable,
        diskFreeBytes: checks.diskFreeBytes,
      }),
    });
  }
  return checks;
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "")));
}

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

function finalAssessment(samples, events = []) {
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
  const sampleFailedCount = events.filter((eventItem) => eventItem.eventType === "sample_failed").length;
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
      sampleFailedZero: sampleFailedCount === 0,
    },
    observed: {
      firstDelta: first.round1vs4KnowledgeDelta ?? null,
      lastDelta: last.round1vs4KnowledgeDelta ?? null,
      firstCurrentDelta: first.round1vsCurrentKnowledgeDelta ?? null,
      lastCurrentDelta: last.round1vsCurrentKnowledgeDelta ?? null,
      minActiveKnowledgeCount: Number.isFinite(minActive) ? minActive : null,
      finalActiveKnowledgeCount: last.activeCount ?? null,
      finalLlmTokenSource: last.llmTokenSource ?? null,
      lastLlmTokenSourceStats: lastTokenSource,
      semanticContradictionBypassCount: semanticBypassCount,
      sampleFailedCount,
      maxConflictCount: maxConflict,
      maxSnapshotConflictCount: maxSnapshotConflict,
      maxResolvedConflictReviews: maxResolved,
      cumulativeConflictEvidence: conflictEvidence,
      maxStallGuardCount: maxStall,
      cyclesClosed: totalClosed,
      earlyPendingGateAverage: earlyGateAvg,
      latePendingGateAverage: lateGateAvg,
      humanGateDropEligible,
      humanGateDropEligibilityThreshold: "earlyPendingGateAverage >= 1",
      humanGatePendingDropRatio: humanGateDrop,
    },
  };
}

function avg(values) {
  if (!values.length) return 0;
  return +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3);
}

async function main() {
  logLine(`Equity Thesis validation starting. logDir=${logDir}`);
  if (existingRun) {
    event("runner_resumed", {
      logDir,
      lastRecordedSample: lastRecordedSample(),
      reason: "resume existing validation log without truncating monitor/events/issues",
    });
  }
  const { baseUrl, child } = await startLocalApp();
  let shuttingDown = false;
  const stopApp = async () => {
    if (shuttingDown || !child || keepApp) return;
    shuttingDown = true;
    child.kill("SIGTERM");
    await sleep(1_000);
    if (child.exitCode == null) child.kill("SIGKILL");
  };
  process.on("SIGINT", async () => {
    event("runner_signal", { signal: "SIGINT" });
    await stopApp();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    event("runner_signal", { signal: "SIGTERM" });
    await stopApp();
    process.exit(143);
  });

  const project = await createProject(baseUrl);
  const canary = await providerCanary(baseUrl, project.id);
  assertValidationCanary(canary);

  const samples = [];
  const firstSample = lastRecordedSample() + 1;
  const state = {
    approvedMeaningCount: 0,
    resolvedConflictReviews: 0,
    currentSample: firstSample,
    meaningGateSequenceById: new Map(),
    heldMeaningGateSampleById: new Map(),
    conflictFloodHeldSamples: new Set(),
    qualityCanaryBaseline: null,
    cognitionCoverageOrdinal: lastCognitionCoverageOrdinal(),
    learningCaseOrdinal: lastLearningCaseOrdinal(),
    lastLearningCaseAction: "",
    learningCaseHardStop: createLearningCaseHardStop({
      onLatch: (failure) => event("learning_case_hard_stop_latched", failure),
    }),
  };
  const started = Date.now();
  const firstRecordedIso = firstRecordedSampleIso();
  const validationStartedAt = firstRecordedIso ? Date.parse(firstRecordedIso) : started;
  const deadlineAt = validationStartedAt + durationMs;
  event("runner_timing_config", {
    durationHours,
    durationMinutes,
    durationMs,
    sampleMs,
    sampleMinutes: +(sampleMs / 60_000).toFixed(3),
    maxSamples,
    progressTicksPerSample,
    seed,
    runId,
    evidenceOrder: evidenceSchedule.map((item) => item.side),
    approveMeaning,
    holdReviewRequiredMeaning,
    holdEveryMeaning,
    holdEveryMeaningUntilSample: Number.isFinite(holdEveryMeaningUntilSample) ? holdEveryMeaningUntilSample : null,
    resolveConflictReviewsTarget,
    scenario,
    conflictFloodHoldSamples,
    conflictFloodMaxResolutionsPerSample: Number.isFinite(conflictFloodMaxResolutionsPerSample) ? conflictFloodMaxResolutionsPerSample : null,
    cognitionCoveragePerSample,
    learningCasesPath: learningCasesInput.path,
    learningCaseCount: learningCases.length,
    learningCasesPerSample,
    learningCaseStartOrdinal: state.learningCaseOrdinal,
    learningCaseDecisionSource: scenario === "learning-cases" ? "runtime_model_prediction" : null,
    learningCaseConflictGateClassification,
    qualityCanaryEverySamples,
    qualityCanaryOffsetSamples,
    metricsSnapshotMinutes,
    watchdogMinutes,
    firstSample,
    firstRecordedIso,
    validationStartedAtIso: new Date(validationStartedAt).toISOString(),
    elapsedBeforeThisProcessMs: Math.max(0, started - validationStartedAt),
  });
  if (scenario === "learning-cases") {
    event("learning_cases_loaded", {
      learningCasesPath: learningCasesInput.path,
      learningCaseCount: learningCases.length,
      learningCasesPerSample,
      firstCaseId: learningCases[0]?.id ?? null,
      lastCaseId: learningCases.at(-1)?.id ?? null,
      decisionSource: "runtime_model_prediction",
      conflictGateClassification: learningCaseConflictGateClassification,
    });
    const warmup = await warmUpLearningCaseAutonomousCycle(baseUrl, project.id, state, { deadlineAt });
    const isolation = warmup.status === "complete"
      ? await isolateLearningWarmupKnowledge(baseUrl, project.id)
      : { status: "skipped", deprecatedCount: 0 };
    state.lastLearningCaseAction = warmup.status === "complete"
      ? `learning_case_autonomous_warmup_complete:${isolation.deprecatedCount ?? 0}_warmup_knowledge_deprecated`
      : state.lastLearningCaseAction;
  }
  let lastAction = "";
  let snapshotIndex = existsSync(metricsDir)
    ? readFileSync(eventsJsonl, "utf8").split(/\r?\n/).filter((line) => line.includes("\"metrics_snapshot_captured\"")).length
    : 0;
  let snapshotChain = Promise.resolve();
  let watchdogChain = Promise.resolve();
  let snapshotTimer = null;
  let watchdogTimer = null;
  const captureError = (kind, reason, sample, error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    issue({
      severity: "P0",
      title: `${kind} failed at sample ${sample}`,
      detail,
    });
    event(`${kind}_failed`, { sample, reason, error: detail });
  };
  const queueSnapshot = (reason) => {
    if (metricsSnapshotMinutes <= 0) return snapshotChain;
    const sampleAtCapture = state.currentSample;
    snapshotChain = snapshotChain
      .then(async () => {
        snapshotIndex += 1;
        await writeMetricsSnapshot(baseUrl, project.id, sampleAtCapture, snapshotIndex, reason);
      })
      .catch((error) => captureError("metrics_snapshot", reason, sampleAtCapture, error));
    return snapshotChain;
  };
  const queueWatchdog = (reason) => {
    if (watchdogMinutes <= 0) return watchdogChain;
    const sampleAtCapture = state.currentSample;
    watchdogChain = watchdogChain
      .then(() => runWatchdog(baseUrl, child, sampleAtCapture))
      .catch((error) => captureError("watchdog", reason, sampleAtCapture, error));
    return watchdogChain;
  };
  const stopPeriodicCaptures = async () => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    await Promise.all([snapshotChain, watchdogChain]);
  };
  if (metricsSnapshotMinutes > 0) {
    queueSnapshot("initial");
    snapshotTimer = setInterval(() => {
      queueSnapshot("interval");
    }, metricsSnapshotMinutes * 60_000);
  }
  if (watchdogMinutes > 0) {
    queueWatchdog("initial");
    watchdogTimer = setInterval(() => {
      queueWatchdog("interval");
    }, watchdogMinutes * 60_000);
  }
  for (let sample = firstSample; sample <= maxSamples; sample += 1) {
    state.currentSample = sample;
    if (Date.now() >= deadlineAt) {
      event("sample_skipped_after_deadline", {
        sample,
        deadlineAt: new Date(deadlineAt).toISOString(),
      });
      break;
    }
    if (child?.exitCode != null) {
      issue({
        severity: "P0",
        title: "app process exited during validation",
        detail: `App exited before sample ${sample}. code=${child.exitCode}, signal=${child.signalCode}`,
      });
      break;
    }
    try {
      if (sample % injectEverySamples === 0) {
        if (scenario === "cognition-coverage") {
          await injectCognitionCoverageBatch(baseUrl, project.id, sample, state);
        } else if (scenario === "learning-cases") {
          await recordLearningCaseBatch(baseUrl, project.id, sample, state, { deadlineAt });
        } else {
          await injectContradictionEvidence(baseUrl, project.id, sample);
        }
      }
      lastAction = scenario === "learning-cases"
        ? state.lastLearningCaseAction || lastAction
        : await progressFlywheel(baseUrl, project.id, state, { deadlineAt });
      const metrics = await collectMetrics(baseUrl, project.id, child?.pid, sample, lastAction);
      samples.push(metrics.row);
      if (qualityCanaryEverySamples > 0 && (sample - qualityCanaryOffsetSamples) % qualityCanaryEverySamples === 0) {
        recordQualityCanary(sample, metrics.knowledge, state);
      }
      if (samples.length > 1 && sample > 4) {
        const prev = samples[samples.length - 2];
        if (metrics.row.knowledgeCount > prev.knowledgeCount && metrics.row.round1vs4KnowledgeDelta === prev.round1vs4KnowledgeDelta) {
          event("delta_static_while_knowledge_grows", {
            sample,
            delta: metrics.row.round1vs4KnowledgeDelta,
            previousKnowledgeCount: prev.knowledgeCount,
            currentKnowledgeCount: metrics.row.knowledgeCount,
          });
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      if (scenario === "learning-cases") {
        const nextCase = learningCases[state.learningCaseOrdinal];
        state.learningCaseHardStop.latch({
          sample,
          ordinal: state.learningCaseOrdinal + 1,
          caseId: nextCase ? learningCaseId(nextCase) : null,
          phase: "sample",
          reason: err,
          latchedAt: new Date().toISOString(),
        });
      }
      issue({
        severity: "P0",
        title: `sample ${sample} failed`,
        detail,
      });
      event("sample_failed", { sample, error: detail });
    }

    if (scenario === "learning-cases" && state.learningCaseHardStop.isLatched()) break;

    const elapsed = Date.now() - validationStartedAt;
    if (sample >= maxSamples || elapsed >= durationMs) break;
    const nextAt = Math.min(started + (sample - firstSample + 1) * sampleMs, deadlineAt);
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  const hardStopBeforeDrain = scenario === "learning-cases" ? state.learningCaseHardStop.snapshot() : null;
  if (hardStopBeforeDrain) await stopPeriodicCaptures();
  const learningCaseQueue = await drainRemainingLearningCases(baseUrl, project.id, state);
  const flywheelDrain = await finalDrainFlywheel(baseUrl, project.id, state);
  const latchedLearningCaseFailure = scenario === "learning-cases" ? state.learningCaseHardStop.snapshot() : null;
  if (!hardStopBeforeDrain) await stopPeriodicCaptures();
  const queueComplete = scenario !== "learning-cases" || learningCaseQueue.status === "complete";
  const finalDrain = {
    ...flywheelDrain,
    status: queueComplete && flywheelDrain.status === "complete" ? "complete" : "incomplete",
    learningCaseQueue,
    flywheel: flywheelDrain,
  };
  await Promise.all([
    queueSnapshot("final"),
    queueWatchdog("final"),
  ]);
  const assessmentSamples = readMonitorSamples();
  const assessment = finalAssessment(assessmentSamples.length ? assessmentSamples : samples, readEvents());
  writeFileSync(summaryJson, JSON.stringify({
    projectId: project.id,
    projectName: project.name,
    baseUrl,
    dbPath,
    logDir,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    validationStartedAt: new Date(validationStartedAt).toISOString(),
    sampleCount: assessmentSamples.length || samples.length,
    processDurationMs: Date.now() - started,
    validationDurationMs: Date.now() - validationStartedAt,
    timing: {
      durationMs,
      sampleMs,
      maxSamples,
      progressTicksPerSample,
    },
    scenario: {
      name: scenario,
      seed,
      runId,
      evidenceOrder: evidenceSchedule.map((item) => item.side),
      qualityCanaryOffsetSamples,
      conflictFloodHoldSamples,
      conflictFloodMaxResolutionsPerSample: Number.isFinite(conflictFloodMaxResolutionsPerSample) ? conflictFloodMaxResolutionsPerSample : null,
      cognitionCoveragePerSample,
      cognitionCoverageInjected: state.cognitionCoverageOrdinal,
      learningCasesPath: learningCasesInput.path,
      learningCaseCount: learningCases.length,
      learningCasesPerSample,
      learningCasesEmitted: state.learningCaseOrdinal,
      learningCaseDecisionSource: scenario === "learning-cases" ? "runtime_model_prediction" : null,
      learningCaseConflictGateClassification,
      learningCaseHardStop: latchedLearningCaseFailure,
      requiredModelCallingAgents: scenario === "learning-cases" ? [...REQUIRED_MODEL_CALLING_AGENTS] : [],
      qualityCanaryEverySamples,
    },
    llmProvider,
    model: openaiModel,
    decisionVia,
    finalDrain,
    assessmentSource: "natural_runtime_summary",
    assessment,
    files: {
      monitorCsv,
      eventsJsonl,
      issuesMd,
      appLogPath,
      runnerLogPath,
      metricsDir,
      opsTrendWarningsPath,
      watchdogPath,
    },
  }, null, 2));
  event("validation_complete", assessment);
  logLine(`Equity Thesis validation complete. summary=${summaryJson}`);
  await stopApp();
  if (latchedLearningCaseFailure) process.exitCode = 1;
}

main().catch((err) => {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  issue({ severity: "P0", title: "runner crashed", detail });
  event("runner_crashed", { error: detail });
  console.error(detail);
  process.exit(1);
});
