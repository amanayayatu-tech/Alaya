#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inferGitHubTarget } from "./lib/github-target.mjs";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function exists(rel) {
  return existsSync(join(root, rel));
}

function has(rel, pattern) {
  if (!exists(rel)) return false;
  return pattern.test(read(rel));
}

function secretFileUsable(path) {
  if (!path || !existsSync(path)) return false;
  try {
    if (readFileSync(path, "utf8").trim().length === 0) return false;
    if (process.platform === "win32") return true;
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function envPresent(...names) {
  return names.some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);
}

function doesNotCallSchedulerTick(rel, callName) {
  if (!exists(rel)) return false;
  const source = read(rel);
  return !source.includes(`${callName}(\`/api/projects/\${project.id}/scheduler/tick`) &&
    !source.includes(`${callName}(\`/api/scheduler/tick`) &&
    !source.includes(`${callName}("${"/api/scheduler/tick"}`) &&
    !source.includes(`${callName}('${"/api/scheduler/tick"}`);
}

function longEvolutionCycleCountAtLeast(minimum) {
  if (!exists("scripts/e2e-long-evolution.mjs")) return false;
  const match = read("scripts/e2e-long-evolution.mjs").match(/TOTAL_CYCLES\s*=\s*(\d+)/);
  return Boolean(match && Number(match[1]) >= minimum);
}

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts ?? {};

const hasOpenAiKey = envPresent("OPENAI_API_KEY") ||
  [process.env.OPENAI_API_KEY_FILE].some(secretFileUsable);
const githubTarget = inferGitHubTarget({ cwd: root });
const hasGithubTarget = Boolean(githubTarget.owner && githubTarget.repo);
const hasGithubToken = envPresent("ALAYA_GITHUB_TOKEN", "GITHUB_TOKEN") ||
  [process.env.ALAYA_GITHUB_TOKEN_FILE, process.env.GITHUB_TOKEN_FILE].some(secretFileUsable);

const checks = [
  {
    id: "layer1-provider",
    layer: "Layer 1",
    kind: "structural",
    ok: has("alaya-core/src/llm/provider.ts", /class\s+OpenAIProvider/) &&
      has("alaya-core/src/llm/provider.ts", /promptVersion/) &&
      has("alaya-core/src/llm/provider.ts", /simplifiedSchema/) &&
      has("alaya-core/src/llm/provider.ts", /degradedToHumanGate/) &&
      has("alaya-core/src/llm/provider.ts", /estimatedCost/) &&
      has("alaya-core/src/llm/provider.ts", /redactSensitiveText/) &&
      has("alaya-core/src/llm/provider.ts", /OPENAI_REQUEST_TIMEOUT_MS/) &&
      has("alaya-core/tests/llm_provider.test.ts", /times out hung requests/) &&
      has("alaya-core/src/llm/provider.ts", /sanitizeAgentContext/) &&
      has("alaya-core/tests/llm_provider.test.ts", /OpenAIProvider redacts PII before provider request and call logging/) &&
      has("alaya-core/tests/llm_provider.test.ts", /falls back to simplified schema after full schema validation fails/) &&
      has("alaya-core/tests/llm_provider.test.ts", /empty env key should not hide the local key file/) &&
      has("alaya-core/tests/llm_agent_outputs.test.ts", /create a non-blocking meaning gate when LLM output degrades/),
    evidence: "OpenAI-compatible provider with prompt version, schema fallback, non-blocking human-gate degradation, cost fields, and LLM-boundary PII redaction",
  },
  {
    id: "layer1-output-consumption",
    layer: "Layer 1",
    kind: "structural",
    ok: has("alaya-core/tests/llm_agent_outputs.test.ts", /core builder consumes LLM task spec text/) &&
      has("alaya-core/tests/llm_agent_outputs.test.ts", /core distiller consumes LLM knowledge candidate/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /LLM K1: operators need visible change boundaries/),
    evidence: "Core and app tests prove LLM output enters plan/task/knowledge while guardrails remain authoritative",
  },
  {
    id: "layer1-real-llm-e2e-config",
    layer: "Layer 1",
    kind: "live",
    ok: hasOpenAiKey,
    evidence: "OPENAI_API_KEY or OPENAI_API_KEY_FILE must be present locally for real MiniMax/OpenAI-compatible E2E",
    next: "Create a local 0600 key file outside the repo, then run OPENAI_API_KEY_FILE=$HOME/.config/alaya/openai-api-key OPENAI_BASE_URL=https://api.minimax.io/openai OPENAI_MODEL=MiniMax-M3 npm run e2e:llm-flywheel",
  },
  {
    id: "layer2-onboarding",
    layer: "Layer 2",
    kind: "structural",
    ok: exists("alaya-app/client/src/pages/NewProject.tsx") &&
      exists("alaya-app/client/src/pages/ProjectSetup.tsx") &&
      exists("alaya-app/server/projectConfig.ts") &&
      has("alaya-app/shared/schema.ts", /oneLiner/) &&
      has("alaya-app/shared/schema.ts", /targetUser/) &&
      has("alaya-app/shared/schema.ts", /currentHypothesis/) &&
      has("alaya-app/shared/schema.ts", /neverDo/) &&
      has("alaya-app/shared/schema.ts", /redlines/) &&
      has("alaya-app/shared/schema.ts", /founderPreference/) &&
      has("alaya-app/shared/schema.ts", /competitors/) &&
      has("alaya-app/shared/schema.ts", /feedbackSources/) &&
      has("alaya-app/shared/schema.ts", /weeklyHumanMinutes/) &&
      has("alaya-app/shared/schema.ts", /firstSignal/) &&
      has("alaya-app/server/onboarding.ts", /callLlm/) &&
      has("alaya-app/server/onboarding.ts", /withGeneratedNote/) &&
      has("alaya-app/server/projectConfig.ts", /syncProjectSeedKnowledge/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /LLM onboarding seed preserves machine-readable interview fields/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /Project Setup edits keep project seed knowledge synchronized/),
    evidence: "Onboarding Interview covers PRD 13.1 dimensions, uses LLM-backed seed generation while preserving machine-readable interview fields, and Project Setup edits keep seed knowledge synchronized",
  },
  {
    id: "layer2-ui-e2e-script",
    layer: "Layer 2",
    kind: "structural",
    ok: Boolean(scripts["e2e:ui-onboarding"]) &&
      exists("scripts/e2e-ui-onboarding-cycle.mjs") &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /page-new-project/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /button-advance-cycle/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /ensureDirectionGate/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /ensureCycleClosed/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /background_opened_direction_gate/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /Project was created and first cycle was advanced through UI controls/) &&
      has("scripts/e2e-ui-onboarding-cycle.mjs", /cycle 1 prediction did not use onboarding claim metric/) &&
      has("alaya-app/client/src/pages/Dashboard.tsx", /button-advance-cycle/) &&
      doesNotCallSchedulerTick("scripts/e2e-ui-onboarding-cycle.mjs", "requestJson"),
    evidence: "UI E2E creates a non-demo project and advances the first cycle through UI controls, while tolerating background scheduler progress without directly calling /scheduler/tick",
  },
  {
    id: "layer3-scheduler",
    layer: "Layer 3",
    kind: "structural",
    ok: exists("alaya-app/server/scheduler.ts") &&
      has("alaya-app/server/scheduler.ts", /startCycleScheduler/) &&
      has("alaya-app/server/scheduler.ts", /executeGateBudget/) &&
      has("alaya-app/server/scheduler.ts", /blockingGatesResolved/) &&
      has("alaya-app/server/scheduler.ts", /feedbackWindowState/) &&
      has("alaya-app/server/scheduler.ts", /auto_approved_repeated_meaning/),
    evidence: "Cycle scheduler and gate budget executor are implemented",
  },
  {
    id: "layer3-autonomous-e2e",
    layer: "Layer 3",
    kind: "structural",
    ok: Boolean(scripts["e2e:scheduler"]) &&
      exists("scripts/e2e-autonomous-scheduler.mjs") &&
      has("scripts/e2e-autonomous-scheduler.mjs", /No \/scheduler\/tick endpoint was called by this script/) &&
      doesNotCallSchedulerTick("scripts/e2e-autonomous-scheduler.mjs", "requestJson") &&
      has("scripts/e2e-autonomous-scheduler.mjs", /background scheduler did not close cycle 1/) &&
      has("scripts/e2e-autonomous-scheduler.mjs", /background scheduler did not create the next cycle direction gate/) &&
      has("scripts/e2e-autonomous-scheduler.mjs", /missing agent run after autonomous close/) &&
      has("scripts/e2e-autonomous-scheduler.mjs", /gateBudget\.used <= dashboard\.gateBudget\.budget/) &&
      has("scripts/e2e-autonomous-scheduler.mjs", /dashboard\.gateBudget\.safetyMode === false/),
    evidence: "Autonomous scheduler E2E proves background cycle close, next direction gate creation, five agent runs, and gate budget safety without calling /scheduler/tick",
  },
  {
    id: "cycle4-rollback-audit-assets",
    layer: "Flywheel",
    kind: "structural",
    ok: has("alaya-app/server/flywheel.ts", /index:\s*4/) &&
      has("alaya-app/server/flywheel.ts", /rollback-ready change package/) &&
      has("alaya-app/server/flywheel.ts", /auditSummaryForCycle4/) &&
      has("alaya-app/server/flywheel.ts", /gate_dir_c4_rollback_/) &&
      has("alaya-app/server/flywheel.ts", /pred_c4_rollback_/) &&
      has("alaya-app/server/flywheel.ts", /rollbackReadyChangePackage/) &&
      has("alaya-app/server/flywheel.ts", /高风险动作进入执行前必须具备可回滚路径与审计摘要/) &&
      has("alaya-app/server/flywheel.ts", /resolveCycleStimulus/) &&
      has("alaya-app/server/scheduler.ts", /buildNextGoalInput/) &&
      has("alaya-app/server/scheduler.ts", /generateNextGoal/) &&
      has("alaya-app/server/scheduler.ts", /evolution_stalled/) &&
      has("alaya-core/src/sim/scenario.ts", /index:\s*4/) &&
      has("alaya-core/src/sim/scenario.ts", /可回滚变更包 \+ 审计摘要/) &&
      has("alaya-core/src/agents/agents.ts", /gate_dir_c4_rollback/) &&
      has("alaya-core/src/agents/agents.ts", /pred_c4_rollback/) &&
      has("alaya-core/src/agents/agents.ts", /rollback-ready change package/) &&
      has("alaya-core/src/agents/agents.ts", /audit summary/) &&
      has("alaya-core/tests/flywheel_4_cycle.test.ts", /cycle 4 with rollback\/audit assets/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /scheduler can compound through four flywheel cycles/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /assert\.notEqual\(cycle4Prediction\.action, cycle3Prediction\.action\)/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /cycle4Payload\.rollbackPlan/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /cycle4Payload\.auditSummary/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /createdByCycle === 4 && k\.type === "principle"/) &&
      has("alaya-app/tests/evolution_engine.test.ts", /scheduler creates autonomous cycle 5 instead of scenario_exhausted/) &&
      longEvolutionCycleCountAtLeast(20),
    evidence: "Cycle 4 is locked as a rollback-ready change package + audit summary stage, with app/core tests proving it is not a copy of cycle 3",
  },
  {
    id: "layer4-sensor",
    layer: "Layer 4",
    kind: "structural",
    ok: exists("alaya-app/server/externalFeedback.ts") &&
      has("alaya-app/server/externalFeedback.ts", /syncGithubIssuesForSource/) &&
      has("alaya-app/server/externalFeedback.ts", /ingestFormFeedback/) &&
      has("alaya-app/server/externalFeedback.ts", /redactPii/) &&
      has("alaya-app/server/externalFeedback.ts", /safeErrorMessage/) &&
      has("alaya-app/server/llm.ts", /redactSensitiveText/) &&
      has("alaya-app/server/llm.ts", /sanitizeInput/) &&
      has("alaya-app/server/llm.ts", /DEFAULT_SIMPLIFIED_SCHEMA/) &&
      has("alaya-app/server/externalFeedback.ts", /createGate/) &&
      has("alaya-app/server/externalFeedback.ts", /classify_external_feedback/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /LLM boundary redacts PII before provider request and call logging/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /app LLM falls back to simplified schema/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /persistedProjectCorpus/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /tokenSecret/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /echoedSecret/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /storage\.listKnowledge\(projectId\)\.length, 0/),
    evidence: "GitHub Issues and form feedback sensors redact, sanitize sync errors, LLM boundary re-redacts provider input/logs, falls back through simplified schema, store source metadata, create meaning gates, and do not write knowledge directly",
  },
  {
    id: "layer4-autonomous-github-script",
    layer: "Layer 4",
    kind: "structural",
    ok: Boolean(scripts["e2e:github-autonomous"]) &&
      exists("scripts/e2e-github-autonomous-sensor.mjs") &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /No \/scheduler\/tick endpoint was called by this script/) &&
      doesNotCallSchedulerTick("scripts/e2e-github-autonomous-sensor.mjs", "appJson") &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /github_issues/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /\[redacted-email\]/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /missing agent run after GitHub autonomous close/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /knowledgeUpdated\.length >= 1/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /background scheduler did not create the next cycle direction gate/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /dashboard\.gateBudget\.used <= dashboard\.gateBudget\.budget/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /dashboard\.gateBudget\.safetyMode === false/),
    evidence: "Real GitHub autonomous E2E is wired, does not manually tick the scheduler, and proves issue ingestion continues through closed cycle, five agent runs, knowledge update, next direction gate, and safe gate budget",
  },
  {
    id: "live-upgrade-runner",
    layer: "Live E2E",
    kind: "structural",
    ok: Boolean(scripts["e2e:live"]) &&
      exists("scripts/e2e-live-upgrade.mjs") &&
      has("scripts/e2e-live-upgrade.mjs", /e2e:llm-flywheel/) &&
      has("alaya-core/src/sim/e2e_real_llm_flywheel.ts", /ALAYA_REAL_LLM_STEP_TIMEOUT_MS/) &&
      has("alaya-core/src/sim/e2e_real_llm_flywheel.ts", /\[real-llm-flywheel\]/) &&
      has("scripts/e2e-live-upgrade.mjs", /e2e:ui-onboarding/) &&
      has("scripts/e2e-live-upgrade.mjs", /e2e:scheduler/) &&
      has("scripts/e2e-live-upgrade.mjs", /e2e:github-autonomous/) &&
      has("scripts/e2e-live-upgrade.mjs", /OPENAI_API_KEY_FILE/) &&
      has("scripts/e2e-live-upgrade.mjs", /GITHUB_TOKEN_FILE/) &&
      has("scripts/e2e-live-upgrade.mjs", /secretFileUsable/) &&
      has("scripts/e2e-live-upgrade.mjs", /envOrFallback/) &&
      has("scripts/e2e-github-autonomous-sensor.mjs", /ALAYA_GITHUB_TOKEN\/GITHUB_TOKEN/) &&
      has("scripts/e2e-github-issue-sensor.mjs", /ALAYA_GITHUB_TOKEN\/GITHUB_TOKEN/) &&
      has("alaya-app/server/llm.ts", /OPENAI_API_KEY_FILE/) &&
      has("alaya-app/server/llm.ts", /OPENAI_REQUEST_TIMEOUT_MS/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /times out hung provider requests/) &&
      has("alaya-app/server/externalFeedback.ts", /ALAYA_GITHUB_TOKEN_FILE/) &&
      has("scripts/setup-local-secrets.mjs", /modeSecure/) &&
      has("scripts/setup-local-secrets.mjs", /usable/) &&
      has("scripts/tests/live-readiness.test.mjs", /uses default user config paths when path env vars are empty/) &&
      has("scripts/tests/live-readiness.test.mjs", /permissions are too broad/) &&
      has("scripts/tests/live-readiness.test.mjs", /refuses broad-permission local secret files/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /app LLM reads the local key file when OPENAI_API_KEY is an empty env var/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /process\.env\.ALAYA_GITHUB_TOKEN = ""/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /process\.env\.GITHUB_TOKEN = ""/) &&
      has("scripts/e2e-live-upgrade.mjs", /ALAYA_AUDIT_REQUIRE_COMPLETE/),
    evidence: "One-command live runner wires real LLM flywheel, UI onboarding, autonomous scheduler, and real GitHub autonomous Sensor E2E using explicit local-only key files and refuses broad-permission secret files",
  },
  {
    id: "layer4-real-github-e2e-config",
    layer: "Layer 4",
    kind: "live",
    ok: hasGithubTarget && hasGithubToken,
    evidence: `GitHub target ${hasGithubTarget ? `${githubTarget.owner}/${githubTarget.repo} inferred from ${githubTarget.source}` : "must be supplied via env or Git remote"}; a local GitHub token must be present for real GitHub autonomous E2E`,
    next: hasGithubTarget
      ? "Create a local 0600 GitHub token file outside the repo, then run GITHUB_TOKEN_FILE=$HOME/.config/alaya/github-token npm run e2e:github-autonomous"
      : "Set ALAYA_E2E_GITHUB_OWNER/ALAYA_E2E_GITHUB_REPO or configure a GitHub origin remote, then create a local 0600 GitHub token file and run npm run e2e:github-autonomous",
  },
  {
    id: "failure-thresholds",
    layer: "PRD 22.5",
    kind: "structural",
    ok: [
      /flywheel_empty_learning/,
      /llm_weekly_budget/,
      /human_attention_overload/,
      /pendingOverBudget2x/,
      /weeklyOverFiveHours/,
      /prediction_measurability_failure/,
      /knowledge_maturity_stagnation/,
      /librarian_stale_conflict_audit_failure/,
      /builder_misdirected_specs/,
    ].every((pattern) => has("alaya-app/server/scheduler.ts", pattern)) &&
      has("alaya-app/server/externalFeedback.ts", /external_feedback_sync_error/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /pending human gate backlog exceeds twice the weekly budget/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /weekly human time exceeds five hours/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /pending blocking gates exceed three/) &&
      has("alaya-app/tests/external_feedback_scheduler.test.ts", /blocking human gate has been pending for more than five days/),
    evidence: "Scheduler encodes PRD 22.5 failure thresholds as blocking risk gates and safety-mode stops, including pending_human overload, weekly human time over five hours, blocking gate count, and stale blocking gates",
  },
];

const structuralFailures = checks.filter((check) => check.kind === "structural" && !check.ok);
const liveMissing = checks.filter((check) => check.kind === "live" && !check.ok);
const complete = structuralFailures.length === 0 && liveMissing.length === 0;

const result = {
  ok: structuralFailures.length === 0,
  complete,
  summary: complete
    ? "All upgrade layers are structurally present and local live credential prerequisites are present; run live E2E to prove provider access."
    : structuralFailures.length > 0
      ? "Structural upgrade checks failed; fix these before live E2E."
      : "Structural upgrade checks passed, but live external E2E prerequisites are missing.",
  counts: {
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    structuralFailures: structuralFailures.length,
    liveMissing: liveMissing.length,
  },
  checks,
  liveNextSteps: liveMissing.map((check) => ({
    id: check.id,
    evidence: check.evidence,
    next: check.next,
  })),
};

console.log(JSON.stringify(result, null, 2));

if (structuralFailures.length > 0) process.exit(1);
if (!complete && process.env.ALAYA_AUDIT_REQUIRE_COMPLETE === "true") process.exit(2);
