import { Store } from "../state/store.js";
import { OpenAIProvider, resolveOpenAIApiKey } from "../llm/provider.js";
import { SCENARIO } from "./scenario.js";
import {
  runOrchestrator,
  humanResolveDirectionGate,
  runSensor,
  runBuilder,
  evaluatePrediction,
  runDistiller,
  runLibrarian,
} from "../agents/agents.js";

const allowSkip = process.env.ALAYA_E2E_ALLOW_SKIP === "true";
const stepTimeoutMs = Number(process.env.ALAYA_REAL_LLM_STEP_TIMEOUT_MS ?? 180_000);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function skip(reason: string, extra: Record<string, unknown> = {}) {
  if (!allowSkip) throw new Error(reason);
  console.log(JSON.stringify({ ok: false, skipped: true, reason, ...extra }, null, 2));
  process.exit(0);
}

function progress(message: string) {
  console.error(`[real-llm-flywheel] ${message}`);
}

async function withStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  progress(`start ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${stepTimeoutMs}ms`)), stepTimeoutMs);
  });
  try {
    const value = await Promise.race([fn(), timeout]);
    progress(`done ${label} (${Date.now() - started}ms)`);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeStore() {
  const store = new Store();
  store.project = {
    id: "proj_real_llm_e2e",
    name: "真实 LLM 飞轮验收",
    direction: "帮独立开发者快速发布",
    targetUser: "独立开发者",
    redlines: ["不自动付款", "不自动公开发布"],
    weeklyHumanMinutes: 150,
  };
  return store;
}

function assertPrd173(store: Store) {
  const cycle3Run = store.agentRuns.find((r) => r.cycleIndex === 3 && r.agent === "orchestrator");
  const refsUsed = cycle3Run?.knowledgeRefsUsed ?? [];
  const checkRefs = refsUsed.length >= 2;

  const reasoning = store.gates.find((g) => g.cycleId === "cycle_3" && g.type === "direction")?.payload.reasoning;
  const reasoningText = typeof reasoning === "string" ? reasoning : "";
  const checkReasoning =
    reasoningText.includes("改变") ||
    reasoningText.toLowerCase().includes("changes") ||
    reasoningText.includes("迁移") ||
    reasoningText.includes("复用");

  const cycle3Plan = store.agentRuns
    .filter((r) => r.cycleIndex === 3 && r.agent === "orchestrator")
    .map((r) => r.outputSummary)
    .join(" ");
  const reproposedRejected = [...store.rejectedDirections].some((direction) => cycle3Plan.includes(direction));
  const pendingHuman = store.gates.filter((g) => g.status === "pending").length;

  const agents = ["orchestrator", "sensor", "builder", "distiller", "librarian"];
  const missingAgentRuns: string[] = [];
  for (let cycleIndex = 1; cycleIndex <= SCENARIO.length; cycleIndex++) {
    for (const agent of agents) {
      if (!store.agentRuns.some((run) => run.cycleIndex === cycleIndex && run.agent === agent)) {
        missingAgentRuns.push(`cycle${cycleIndex}:${agent}`);
      }
    }
  }

  const c1Prediction = store.predictions.find((prediction) => prediction.cycleId === "cycle_1");
  const checks = {
    refsUsed: checkRefs,
    reasoningChangedDecision: checkReasoning,
    noRejectedDirectionRepeated: !reproposedRejected,
    pendingHumanBounded: pendingHuman <= 5,
    allAgentsRan: missingAgentRuns.length === 0,
    hasStrongKnowledge: store.strongKnowledge().length >= 1,
    predictionErrorRouted:
      c1Prediction?.errorType === "model" &&
      c1Prediction.updateTarget === "distiller_world_model_update",
  };

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  assert(failed.length === 0, `PRD 17.3 failed checks: ${failed.join(", ")}`);

  return {
    checks,
    refsUsed,
    reasoning: reasoningText,
    pendingHuman,
    strongKnowledge: store.strongKnowledge().length,
    missingAgentRuns,
  };
}

function assertCycle4Compounds(store: Store) {
  const cycle3Prediction = store.predictions.find((prediction) => prediction.cycleId === "cycle_3");
  const cycle4Prediction = store.predictions.find((prediction) => prediction.cycleId === "cycle_4");
  const cycle4Gate = store.gates.find((gate) => gate.cycleId === "cycle_4" && gate.type === "direction");
  const cycle4Principle = [...store.knowledge.values()].find((item) => item.createdByCycle === 4 && item.type === "principle");
  const payload = cycle4Gate?.payload ?? {};
  const checks = {
    hasCycle4Prediction: Boolean(cycle4Prediction),
    predictionIdNamesRollbackAsset: cycle4Prediction?.id === "pred_c4_rollback",
    actionDiffersFromCycle3: Boolean(cycle3Prediction && cycle4Prediction && cycle4Prediction.action !== cycle3Prediction.action),
    actionMentionsRollbackAudit: Boolean(cycle4Prediction && /回滚|审计|rollback|audit/i.test(cycle4Prediction.action)),
    directionGateHasRollbackPlan: Boolean(payload.rollbackPlan),
    directionGateHasAuditSummary: Boolean(payload.auditSummary),
    hasCycle4Principle: Boolean(cycle4Principle),
    principleMentionsRollbackAudit: Boolean(cycle4Principle && /可回滚路径与审计摘要|rollback-ready change package|audit summary/i.test(`${cycle4Principle.title} ${cycle4Principle.content}`)),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  assert(failed.length === 0, `cycle 4 compounding failed checks: ${failed.join(", ")}`);
  return {
    checks,
    gateId: cycle4Gate?.id,
    predictionId: cycle4Prediction?.id,
    principleId: cycle4Principle?.id,
  };
}

function assertLlmCallsHealthy(store: Store) {
  const expectedCalls = SCENARIO.length * 5;
  assert(store.llmCalls.length === expectedCalls, `expected ${expectedCalls} LLM calls, got ${store.llmCalls.length}`);
  const invalid = store.llmCalls.filter((call) => !call.schemaValid);
  assert(invalid.length === 0, `real LLM schema validation failed for: ${invalid.map((call) => `${call.cycleIndex}:${call.agent}:${call.promptVersion} output=${call.outputSummary}`).join(", ")}`);

  const degraded = store.gates.filter((gate) => gate.id.startsWith("gate_llm_"));
  assert(degraded.length === 0, `real LLM degraded gates were created: ${degraded.map((gate) => gate.id).join(", ")}`);

  for (const call of store.llmCalls) {
    assert(call.provider === "openai", `unexpected LLM provider in log: ${call.provider}`);
    assert(call.promptVersion.endsWith("@v1"), `missing prompt version: ${call.promptVersion}`);
    assert(call.inputSummary.length > 0, `missing input summary for ${call.agent}`);
    assert(call.outputSummary.length > 0, `missing output summary for ${call.agent}`);
    assert(call.retryCount >= 0, `missing retry count for ${call.agent}`);
    assert(call.latencyMs >= 0, `missing latency for ${call.agent}`);
    assert(call.tokenCount > 0, `missing token count for ${call.agent}`);
    assert(call.estimatedCost >= 0, `missing estimated cost for ${call.agent}`);
  }

  return {
    count: store.llmCalls.length,
    totalTokens: store.llmCalls.reduce((sum, call) => sum + call.tokenCount, 0),
    totalEstimatedCost: +store.llmCalls.reduce((sum, call) => sum + call.estimatedCost, 0).toFixed(6),
    promptVersions: [...new Set(store.llmCalls.map((call) => call.promptVersion))].sort(),
  };
}

async function main() {
  if (!resolveOpenAIApiKey()) {
    skip("OPENAI_API_KEY or OPENAI_API_KEY_FILE is not set; real LLM flywheel was not run.");
  }

  const store = makeStore();
  const llm = new OpenAIProvider({
    maxRetries: Number(process.env.ALAYA_REAL_LLM_MAX_RETRIES ?? 0),
    temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0),
    maxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 512),
  });

  for (const scenario of SCENARIO) {
    progress(`cycle ${scenario.index} begin`);
    const plan = await withStep(`cycle ${scenario.index} orchestrator`, () => runOrchestrator(store, scenario, llm));
    humanResolveDirectionGate(store, plan.gate, scenario);
    await withStep(`cycle ${scenario.index} sensor`, () => runSensor(store, scenario, llm));
    await withStep(`cycle ${scenario.index} builder`, () => runBuilder(store, scenario, llm, plan.action, plan.refs));
    const { pred, claim } = evaluatePrediction(store, scenario, plan);
    await withStep(`cycle ${scenario.index} distiller`, () => runDistiller(store, scenario, pred, claim.error ?? 0, llm));
    await withStep(`cycle ${scenario.index} librarian`, () => runLibrarian(store, scenario, llm));
    progress(`cycle ${scenario.index} closed`);
  }

  const llmCalls = assertLlmCallsHealthy(store);
  const prd173 = assertPrd173(store);
  const cycle4 = assertCycle4Compounds(store);

  console.log(JSON.stringify({
    ok: true,
    provider: llm.name,
    llmCalls,
    prd173,
    cycle4,
    eventLogCount: store.eventLog.length,
    decisionLogCount: store.decisionLog.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(`Real LLM Flywheel E2E failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
