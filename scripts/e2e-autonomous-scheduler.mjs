#!/usr/bin/env node

const baseUrl = process.env.ALAYA_E2E_BASE_URL ?? "http://127.0.0.1:5000";
const allowSkip = process.env.ALAYA_E2E_ALLOW_SKIP === "true";
const timeoutMs = Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 60_000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function skip(reason) {
  if (!allowSkip) throw new Error(reason);
  console.log(JSON.stringify({ ok: false, skipped: true, reason }, null, 2));
  process.exit(0);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = typeof data?.message === "string" ? data.message : text.slice(0, 300);
    throw new Error(`${options.method ?? "GET"} ${path} failed ${response.status}: ${detail}`);
  }
  return data;
}

async function waitForApp() {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await requestJson("/api/projects");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  skip(`Alaya app is not reachable at ${baseUrl}: ${lastError?.message ?? "timeout"}`);
}

async function waitUntil(fn, message, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

async function main() {
  await waitForApp();
  const runId = Date.now().toString(36);
  const project = await requestJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `Autonomous Scheduler E2E ${runId}`,
      oneLiner: "验证后台 scheduler 能自动推进认知飞轮",
      targetUser: "需要低人工触发复盘系统的独立经营者",
      currentHypothesis: "只处理 human gate,不手动触发 tick,系统也能完成首轮闭环",
      neverDo: "不调用 /scheduler/tick 作为验收捷径",
      redlines: ["blocking gate 未处理不得推进", "外部反馈不得直接写入强知识"],
      founderPreference: "自动化可以慢,但必须可审计",
      competitors: "手动周报,人工 issue triage",
      feedbackSources: "表单反馈",
      weeklyHumanMinutes: 120,
      weeklyLlmBudgetCents: 100,
      firstClaimMetric: "approved_direction_gate_count",
      firstClaimOperator: ">=",
      firstClaimTarget: 1,
      firstSignal: "后台调度在反馈到达后自动关闭首轮并创建下一轮方向闸",
    }),
  });

  const cycle1Id = `cycle_1_${project.id.slice(-4)}`;

  const directionGate = await waitUntil(async () => {
    const gates = await requestJson(`/api/human-gates?projectId=${project.id}`);
    return gates.find((gate) => gate.cycleId === cycle1Id && gate.type === "direction" && gate.blocking === 1 && gate.status === "pending");
  }, "background scheduler did not open the first direction gate; start the app with ALAYA_SCHEDULER_INTERVAL_MS=500");

  const form = await requestJson(`/api/projects/${project.id}/feedback/form`, {
    method: "POST",
    body: JSON.stringify({
      sourceName: "autonomous-e2e-form",
      externalId: runId,
      title: "用户希望看到自动复盘",
      text: "I want the system to keep learning after I approve the direction gate. Email alaya-autonomous@example.com should be redacted.",
      url: `https://example.com/alaya/autonomous/${runId}`,
    }),
  });
  assert(form.imported === true, "form feedback was not imported");
  assert(form.gate?.type === "meaning" && form.gate?.blocking === 0, "form feedback did not create a non-blocking meaning gate");
  assert(!String(form.feedback?.text ?? "").includes("alaya-autonomous@example.com"), "form feedback PII was not redacted");

  await requestJson(`/api/human-gates/${directionGate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ rationale: "approve direction gate for autonomous scheduler e2e" }),
  });

  const closedCycle1 = await waitUntil(async () => {
    const cycles = await requestJson(`/api/projects/${project.id}/cycles`);
    return cycles.find((cycle) => cycle.idx === 1 && cycle.status === "closed");
  }, "background scheduler did not close cycle 1 after the blocking gate was approved");

  const cycle2DirectionGate = await waitUntil(async () => {
    const cycles = await requestJson(`/api/projects/${project.id}/cycles`);
    const cycle2 = cycles.find((cycle) => cycle.idx === 2);
    if (!cycle2) return null;
    const gates = await requestJson(`/api/human-gates?projectId=${project.id}`);
    const gate = gates.find((item) => item.cycleId === cycle2.id && item.type === "direction" && item.blocking === 1 && item.status === "pending");
    return gate ? { cycle2, gate } : null;
  }, "background scheduler did not create the next cycle direction gate");

  const review = await requestJson(`/api/cycles/${closedCycle1.id}/review`);
  const agents = new Set(review.agentRuns.map((run) => run.agent));
  for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
    assert(agents.has(agent), `missing agent run after autonomous close: ${agent}`);
  }
  assert(review.feedback.some((item) => item.sourceType === "form_feedback" && item.sourceRef === `autonomous-e2e-form:${runId}`), "cycle review did not retain the external form feedback");
  assert(review.predictions.length >= 1, "autonomous cycle did not create a prediction");
  assert(review.knowledgeUpdated.length >= 1, "autonomous cycle did not update knowledge");

  const dashboard = await requestJson(`/api/projects/${project.id}/dashboard`);
  assert(dashboard.gateBudget.used <= dashboard.gateBudget.budget, "gate budget used minutes exceeds weekly budget");
  assert(dashboard.gateBudget.pendingBlocking <= 1, "more than one blocking gate is pending after autonomous advance");
  assert(dashboard.gateBudget.safetyMode === false, "scheduler entered safety mode during autonomous E2E");

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    cycle1Id: closedCycle1.id,
    cycle2Id: cycle2DirectionGate.cycle2.id,
    directionGateId: directionGate.id,
    nextDirectionGateId: cycle2DirectionGate.gate.id,
    formFeedbackId: form.feedback.id,
    agents: [...agents].sort(),
    gateBudget: dashboard.gateBudget,
    note: "No /scheduler/tick endpoint was called by this script.",
  }, null, 2));
}

main().catch((error) => {
  console.error(`Autonomous Scheduler E2E failed: ${error.message}`);
  process.exit(1);
});
