#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REQUIRED_LLM_PROVIDER = "openai";
const REQUIRED_OPENAI_BASE_URL = "https://api.minimax.io/openai";
const REQUIRED_OPENAI_MODEL = "MiniMax-M3";
const LAUNCH_GUARD_FAILURE_EXIT_CODE = 2;

const PROJECT_NAME = "wearable-health-signal-decision";
function projectDescription() {
  return [
    "你是某智能健康硬件的产品决策系统。你需要对一个穿戴设备的核心传感器选型做出决策：",
    "在用户静息心率监测场景下，应该优先选用 光学 PPG 传感器 还是 生物电阻抗 ECG 方案？",
    "",
    "已知约束：设备定价目标 ¥899，续航目标 7 天，目标用户是 35-50 岁亚健康白领，需要通过 NMPA 三类医疗器械认证。",
    "",
    `本次验证窗口为 ${durationTextZh}，每 5 分钟采样一次。每轮必须复用当前知识库，不得只重算单轮结论；最终需要观察知识熵变、Human Gate 收敛、冲突解决和 Stall Guard 触发率。`,
    "",
    "每轮任务：基于当前知识库，给出当前最优选型决策，并列明置信度与关键证据。如果遇到矛盾证据，必须在知识库中记录冲突并等待人工审核。",
  ].join("\n");
}

const STARTUP_FINDINGS = [
  {
    severity: "P2",
    title: "first four cycle stimuli are partly hard-coded to the generic high-risk automation scenario",
    detail: "The health-signal onboarding prompt affects seed/project context, but the built-in flywheel scenarios still inject generic product automation feedback. The runner adds PPG/ECG contradiction evidence through the form-feedback path to test the conflict pipeline.",
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
    side: "ppg_support",
    title: "PPG 优先证据：成本与续航匹配",
    text: [
      "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
      "ppg_priority_score >= 0.78。",
      "当前最优选型决策：优先 PPG，置信度 0.64。",
      "关键证据：日常趋势监测、佩戴舒适度、连续采样和成本约束更匹配 PPG。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "ecg_support",
    title: "ECG 优先证据：医疗认证与信号可解释性",
    text: [
      "ECG 优先：生物电阻抗 ECG 的心电信号更可解释，NMPA 三类医疗器械认证路径上比单纯 PPG 更有说服力。",
      "ppg_priority_score <= 0.35。",
      "明确冲突：该结论与“PPG 优先”互相矛盾，必须进入 conflict 知识状态并等待人工审核。",
      "当前最优选型决策：优先 ECG，置信度 0.66。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "ppg_risk",
    title: "PPG 反证：肤色/佩戴/运动干扰",
    text: [
      "PPG 风险：肤色、佩戴松紧、环境光和运动伪影会影响 PPG 静息心率可靠性。",
      "ppg_priority_score <= 0.42。",
      "明确冲突：该证据削弱之前 PPG 优先结论，不能直接复用为 active 决策依据。",
      "建议：保留 PPG 作为低功耗连续趋势传感器，但医疗级判定需要 ECG 或人工复核。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "ecg_risk",
    title: "ECG 反证：功耗/交互/成本压力",
    text: [
      "ECG 风险：ECG 需要更严格电极接触和主动测量交互，连续 7 天续航与 ¥899 定价下硬件和体验成本更高。",
      "ppg_priority_score >= 0.72。",
      "明确冲突：该证据反驳 ECG 优先，必须隔离到冲突审查流程。",
      "当前最优选型决策：PPG 做连续监测，ECG 作为二次确认模块，置信度 0.61。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "hybrid_support",
    title: "混合方案证据：PPG 连续 + ECG 复核",
    text: [
      "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
      "hybrid_decision_confidence >= 0.81。",
      "明确冲突：混合方案与单一 PPG/单一 ECG 优先的结论都存在边界冲突，需要人工审核选择约束优先级。",
      "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
    ].join("\n"),
  }),
  evidenceTemplate({
    side: "hybrid_reject",
    title: "混合方案反证：BOM 与认证复杂度过高",
    text: [
      "反对混合方案：双传感器方案会抬高 BOM、结构复杂度和认证范围，可能破坏 ¥899 定价目标。",
      "hybrid_decision_confidence <= 0.38。",
      "明确冲突：该结论与混合方案推荐互相矛盾，不能同时作为 active 知识复用。",
      "当前最优选型决策：先 PPG，保留 ECG 作为 Pro SKU，置信度 0.63。",
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

const args = parseArgs(process.argv.slice(2));

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
  console.error("Health Signal validation launch guard failed:");
  for (const error of launchGuard.errors) console.error(`- ${error}`);
  process.exit(LAUNCH_GUARD_FAILURE_EXIT_CODE);
}

const durationHours = numArg("duration-hours", 36);
const durationMinutes = numArg("duration-minutes", 0);
const durationLabel = durationMinutes > 0 ? `${durationHours}h${durationMinutes}m` : `${durationHours}h`;
const durationTextZh = durationMinutes > 0 ? `${durationHours} 小时 ${durationMinutes} 分钟` : `${durationHours} 小时`;
const durationMs = Math.max(1_000, durationHours * 3_600_000 + durationMinutes * 60_000);
const sampleMs = Math.max(1_000, numArg("sample-minutes", 5) * 60_000 + numArg("sample-seconds", 0) * 1_000);
const maxSamples = Math.max(1, Math.min(Math.ceil(durationMs / sampleMs), Math.trunc(numArg("max-samples", Number.POSITIVE_INFINITY))));
const scenario = args.scenario || "standard";
if (!["standard", "conflict-flood"].includes(scenario)) {
  console.error(`Unsupported --scenario=${JSON.stringify(scenario)}. Expected standard or conflict-flood.`);
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
const qualityCanaryEverySamples = Math.max(0, Math.trunc(numArg("quality-canary-every-samples", 5)));

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

function logLine(message) {
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(runnerLogPath, `${line}\n`);
  console.error(line);
}

function event(eventType, data = {}) {
  appendFileSync(eventsJsonl, `${JSON.stringify({ ts: new Date().toISOString(), eventType, ...data })}\n`);
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
  writeFileSync(issuesMd, `# Health Signal ${durationLabel} Validation Issues\n\nLog dir: ${logDir}\n`);
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
    targetUser: "35-50 岁亚健康白领；匿名智能健康硬件产品与合规团队",
    currentHypothesis: `在 ${durationTextZh} 连续验证窗口内，¥899 定价、7 天续航和 NMPA 三类认证约束会持续拉扯 PPG/ECG/混合方案选型；系统必须复用历史知识、隔离矛盾知识并让 Human Gate 触发率逐步收敛。`,
    neverDo: "不得把互相矛盾的 PPG/ECG 结论同时作为 active 决策事实复用；不得绕过 NMPA 三类认证约束。",
    redlines: [
      "遇到 PPG vs ECG 选型矛盾必须记录 conflict 并等待人工审核",
      "低置信度或单轮 LLM 结论不得直接晋级 strong",
      "所有传感器选型建议必须同时说明成本、续航、目标用户和认证约束",
    ],
    founderPreference: "优先满足 ¥899 与 7 天续航，但不能牺牲医疗器械认证路径与长期可信度。",
    competitors: "Apple Watch ECG/PPG、医疗级 Holter、国产健康手环 PPG、血压/心电一体腕带",
    feedbackSources: `Codex ${durationLabel} runner 表单反馈矛盾注入、Alaya agent outputs、Human Gate 审核`,
    weeklyHumanMinutes: 10080,
    weeklyLlmBudgetCents: 1_000_000,
    firstClaimMetric: "decision_confidence",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.7,
    firstSignal: `每轮输出当前 PPG/ECG/混合方案选型、置信度、关键证据和冲突记录；${durationLabel} 全程观察 delta、Human Gate、conflict resolution 和 Stall Guard。`,
  };
}

function projectConfigPatch() {
  const payload = projectPayload();
  const validationNote = [
    `${durationLabel} 验证目标:`,
    `本轮 Health Signal 验证窗口为 ${durationTextZh}；runner 使用 sample-minutes=${+(sampleMs / 60_000).toFixed(3)}、progress-ticks-per-sample=${progressTicksPerSample}、max-samples=${maxSamples}。`,
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
    title: "Health Signal launch guard rejected provider canary",
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
  const template = EVIDENCE_TEMPLATES[(sample - 1) % EVIDENCE_TEMPLATES.length];
  const externalId = `sample_${String(sample).padStart(4, "0")}_${template.side}`;
  const result = await requestJson(baseUrl, `/api/projects/${projectId}/feedback/form`, {
    method: "POST",
    body: {
      sourceName: "health-signal-contradiction-runner",
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
    ...oracleEventFields(template.side),
    imported: result.imported,
    skipped: result.skipped,
    gateId: result.gate?.id ?? null,
    classification: result.classification,
  });
  return result;
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

function shouldHoldMeaningGate(gate, state) {
  if (!approveMeaning) return true;
  if (scenario === "conflict-flood" && isHealthSignalContradictionGate(gate)) return false;
  const payload = parsePayload(gate);
  if (payload.riskKey === "knowledge_review_reminder") return true;
  if (holdReviewRequiredMeaning && meaningGateRequiresHumanReview(gate)) return true;
  if (holdEveryMeaning > 0 && state.currentSample <= holdEveryMeaningUntilSample) {
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

function isHealthSignalContradictionGate(gate) {
  const payload = parsePayload(gate);
  const sourceName = String(payload.sourceName ?? "");
  const externalId = String(payload.externalId ?? "");
  const userQuote = String(payload.userQuote ?? "");
  return sourceName === "health-signal-contradiction-runner"
    || /^sample_\d{4}_(?:ppg_support|ecg_support|ppg_risk|ecg_risk|hybrid_support|hybrid_reject)$/.test(externalId)
    || /health-signal-contradiction-runner\s+sample_\d{4}_/.test(userQuote);
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

async function resolvePendingGates(baseUrl, projectId, state) {
  const gates = await requestJson(baseUrl, `/api/human-gates?projectId=${projectId}`);
  for (const gate of gates.filter((item) => item.status === "pending")) {
    const payload = parsePayload(gate);
    if (gate.type === "meaning" && shouldHoldMeaningGate(gate, state)) {
      event("gate_left_pending_for_sampling", { gateId: gate.id, gateType: gate.type, title: gate.title });
      continue;
    }
    if (gate.type === "risk" && payload.riskKey === "knowledge_conflict_review") {
      event("conflict_gate_left_to_review_resolver", { gateId: gate.id, reviewId: payload.reviewId });
      continue;
    }
    const rationale = [
      `Health Signal ${durationLabel} validation human proxy via ${decisionVia}.`,
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
    const action = state.resolvedConflictReviews % 2 === 0 ? "quarantine" : "merge_supersede";
    const body = action === "merge_supersede" && review.relatedKnowledgeId
      ? {
          action,
          survivorKnowledgeId: review.relatedKnowledgeId,
          rationale: `Health Signal validation human proxy via ${decisionVia}: resolve conflict by preserving related item as survivor after recording contradiction.`,
        }
      : {
          action: "quarantine",
          rationale: `Health Signal validation human proxy via ${decisionVia}: quarantine weaker conflicting item to verify conflict convergence.`,
        };
    const primaryOracleSide = inferOracleSideFromValue(review.primaryKnowledgeId);
    const relatedOracleSide = inferOracleSideFromValue(review.relatedKnowledgeId);
    const resolutionScore = scoreResolutionEvent({
      reviewId: review.id,
      primaryKnowledgeId: review.primaryKnowledgeId,
      relatedKnowledgeId: review.relatedKnowledgeId,
      primaryOracleSide,
      relatedOracleSide,
      action: body.action,
      survivorKnowledgeId: body.survivorKnowledgeId ?? null,
    });
    const resolved = await requestJson(baseUrl, `/api/knowledge-reviews/${review.id}/resolve`, {
      method: "POST",
      body,
    });
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

async function finalDrainFlywheel(baseUrl, projectId, state) {
  const maxDrainTicks = 3;
  let lastAction = "";
  for (let attempt = 1; attempt <= maxDrainTicks; attempt += 1) {
    await resolvePendingGates(baseUrl, projectId, state);
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

    const tick = await requestJson(baseUrl, `/api/projects/${projectId}/scheduler/tick`, {
      method: "POST",
      body: { syncFeedback: false },
    });
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
    hybridLayeredCount: decisionTsr.hybridLayeredCount,
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
      hybridLayeredDelta: current.hybridLayeredCount - state.qualityCanaryBaseline.hybridLayeredCount,
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
    /contradiction|conflict|矛盾|冲突|ppg|ecg|hybrid/i.test(JSON.stringify(eventItem))
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
  logLine(`Health Signal validation starting. logDir=${logDir}`);
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
  };
  const started = Date.now();
  const firstRecordedIso = firstRecordedSampleIso();
  const validationStartedAt = firstRecordedIso ? Date.parse(firstRecordedIso) : started;
  event("runner_timing_config", {
    durationHours,
    durationMinutes,
    durationMs,
    sampleMs,
    sampleMinutes: +(sampleMs / 60_000).toFixed(3),
    maxSamples,
    progressTicksPerSample,
    approveMeaning,
    holdReviewRequiredMeaning,
    holdEveryMeaning,
    holdEveryMeaningUntilSample: Number.isFinite(holdEveryMeaningUntilSample) ? holdEveryMeaningUntilSample : null,
    resolveConflictReviewsTarget,
    scenario,
    conflictFloodHoldSamples,
    conflictFloodMaxResolutionsPerSample: Number.isFinite(conflictFloodMaxResolutionsPerSample) ? conflictFloodMaxResolutionsPerSample : null,
    qualityCanaryEverySamples,
    metricsSnapshotMinutes,
    watchdogMinutes,
    firstSample,
    firstRecordedIso,
    validationStartedAtIso: new Date(validationStartedAt).toISOString(),
    elapsedBeforeThisProcessMs: Math.max(0, started - validationStartedAt),
  });
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
  const deadlineAt = validationStartedAt + durationMs;
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
        await injectContradictionEvidence(baseUrl, project.id, sample);
      }
      lastAction = await progressFlywheel(baseUrl, project.id, state, { deadlineAt });
      const metrics = await collectMetrics(baseUrl, project.id, child?.pid, sample, lastAction);
      samples.push(metrics.row);
      if (qualityCanaryEverySamples > 0 && sample % qualityCanaryEverySamples === 0) {
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
      issue({
        severity: "P0",
        title: `sample ${sample} failed`,
        detail,
      });
      event("sample_failed", { sample, error: detail });
    }

    const elapsed = Date.now() - validationStartedAt;
    if (sample >= maxSamples || elapsed >= durationMs) break;
    const nextAt = started + (sample - firstSample + 1) * sampleMs;
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  await stopPeriodicCaptures();
  const finalDrain = await finalDrainFlywheel(baseUrl, project.id, state);
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
      conflictFloodHoldSamples,
      conflictFloodMaxResolutionsPerSample: Number.isFinite(conflictFloodMaxResolutionsPerSample) ? conflictFloodMaxResolutionsPerSample : null,
      qualityCanaryEverySamples,
    },
    llmProvider,
    model: openaiModel,
    decisionVia,
    finalDrain,
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
  logLine(`Health Signal validation complete. summary=${summaryJson}`);
  await stopApp();
}

main().catch((err) => {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  issue({ severity: "P0", title: "runner crashed", detail });
  event("runner_crashed", { error: detail });
  console.error(detail);
  process.exit(1);
});
