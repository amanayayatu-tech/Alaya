#!/usr/bin/env node

const baseUrl = process.env.ALAYA_E2E_BASE_URL ?? "http://127.0.0.1:5000";
const allowSkip = process.env.ALAYA_E2E_ALLOW_SKIP === "true";
const headless = process.env.ALAYA_E2E_HEADLESS !== "false";
const timeoutMs = Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 45_000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function skip(reason) {
  if (!allowSkip) throw new Error(reason);
  console.log(JSON.stringify({ ok: false, skipped: true, reason }, null, 2));
  process.exit(0);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    skip("Playwright is not installed; install it or run without ALAYA_E2E_ALLOW_SKIP for a hard failure.");
  }
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

async function waitUntil(fn, message) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

async function fillByLabel(page, label, value) {
  await page.getByLabel(label, { exact: true }).fill(value);
}

async function clickAdvanceCycle(page, expectedAction) {
  await page.getByTestId("button-advance-cycle").click();
  const action = await waitUntil(async () => {
    const node = page.getByTestId("text-last-scheduler-action");
    try {
      const text = await node.textContent({ timeout: 500 });
      return text?.includes(expectedAction) ? text : null;
    } catch {
      return null;
    }
  }, `UI advance button did not report ${expectedAction}`);
  return action;
}

async function findPendingDirectionGate(projectId, cycleId) {
  const gates = await requestJson(`/api/human-gates?projectId=${projectId}`);
  return gates.find((gate) => gate.cycleId === cycleId && gate.type === "direction" && gate.blocking === 1 && gate.status === "pending");
}

async function ensureDirectionGate(page, projectId, cycleId) {
  const existing = await findPendingDirectionGate(projectId, cycleId);
  if (existing) return { gate: existing, action: "background_opened_direction_gate" };

  await page.getByTestId("button-advance-cycle").click();
  return waitUntil(async () => {
    const gate = await findPendingDirectionGate(projectId, cycleId);
    if (!gate) return null;
    let text = "";
    try {
      text = await page.getByTestId("text-last-scheduler-action").textContent({ timeout: 500 }) ?? "";
    } catch {
      text = "";
    }
    return { gate, action: text || "opened_direction_gate" };
  }, "direction gate was not opened by UI advance or background scheduler");
}

async function ensureCycleClosed(page, projectId, cycleId) {
  const current = await requestJson(`/api/cycles/${cycleId}`);
  if (current.status === "closed") return { cycle: current, action: "background_ran_operational_stages" };

  await page.getByTestId("button-advance-cycle").click();
  return waitUntil(async () => {
    const cycle = await requestJson(`/api/cycles/${cycleId}`);
    if (cycle.status !== "closed") return null;
    let text = "";
    try {
      text = await page.getByTestId("text-last-scheduler-action").textContent({ timeout: 500 }) ?? "";
    } catch {
      text = "";
    }
    return { cycle, action: text || "ran_operational_stages" };
  }, "cycle 1 was not closed by UI advance or background scheduler");
}

async function main() {
  await waitForApp();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const runId = Date.now().toString(36);
  const projectName = `UI Onboarding E2E ${runId}`;

  try {
    await page.goto(`${baseUrl}/#/projects/new`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("page-new-project").waitFor({ timeout: timeoutMs });

    await fillByLabel(page, "项目名称", projectName);
    await fillByLabel(page, "产品一句话", "面向独立经营者的复盘自动化工作台");
    await fillByLabel(page, "目标用户", "每周需要把外部反馈转成产品动作的独立经营者");
    await fillByLabel(page, "当前最想验证的假设", "带人工闸门的自动复盘能减少重复决策");
    await fillByLabel(page, "创始人偏好", "保守推进,所有高风险动作必须可追责");
    await fillByLabel(page, "第一轮希望看到的外部信号", "用户愿意批准第一轮方向闸");
    await fillByLabel(page, "第一轮指标 key", "approved_review_gate_count");
    await fillByLabel(page, "目标阈值", "1");
    await fillByLabel(page, "绝不做什么", "不跳过人工闸门;不把模糊反馈直接写入强知识");
    await fillByLabel(page, "高风险红线", "不得泄露隐私\n不得自动批准 high-risk execution");
    await fillByLabel(page, "已知竞品", "Notion AI, Linear triage, manual weekly review");
    await fillByLabel(page, "当前可用反馈来源", "GitHub Issues, 表单反馈, 用户访谈");
    await fillByLabel(page, "每周人工预算分钟", "120");
    await fillByLabel(page, "每周 LLM 预算 cents", "80");

    await page.getByTestId("button-create-project").click();
    await page.getByTestId("page-dashboard").waitFor({ timeout: timeoutMs });
    await page.getByTestId("text-current-project").waitFor({ timeout: timeoutMs });

    const projects = await requestJson("/api/projects");
    const project = projects.find((item) => item.name === projectName);
    assert(project, "created project was not returned by /api/projects");
    assert(project.name !== "Alaya Demo", "E2E project must be distinct from demo");
    assert(String(project.seedIdentity ?? "").length > 20, "seed identity was not persisted");
    assert(String(project.worldModel ?? "").length > 20, "world model was not persisted");
    assert(project.weeklyHumanMinutes === 120, "weekly human budget was not persisted");
    assert(project.weeklyLlmBudgetCents === 80, "weekly LLM budget was not persisted");
    assert(project.firstClaimMetric === "approved_review_gate_count", "first claim metric was not persisted");
    assert(project.firstClaimOperator === ">=", "first claim operator was not persisted");
    assert(project.firstClaimTarget === 1, "first claim target was not persisted");

    const cycle1Id = `cycle_1_${project.id.slice(-4)}`;
    const opened = await ensureDirectionGate(page, project.id, cycle1Id);

    await page.goto(`${baseUrl}/#/gates`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("select-project").selectOption({ label: projectName });
    await page.getByTestId("page-gates").waitFor({ timeout: timeoutMs });

    const directionGate = await findPendingDirectionGate(project.id, cycle1Id) ?? opened.gate;
    assert(directionGate, "direction gate was not created for the UI-created project");
    const directionText = [
      directionGate.payload?.recommended,
      directionGate.payload?.belief,
      directionGate.payload?.prediction,
      directionGate.payload?.action,
      directionGate.payload?.reasoning,
    ].map((item) => String(item ?? "")).join("\n");
    assert(directionText.length > 40, "direction gate did not produce a substantive first-cycle plan");
    assert(!directionText.includes("一键发布"), "direction gate fell back to the demo one-click publish scenario");
    const approveButton = page.getByTestId(`button-approve-${directionGate.id}`);
    await approveButton.waitFor({ timeout: timeoutMs });
    await approveButton.click();
    await page.getByTestId("button-confirm-gate-action").click();

    await waitUntil(async () => {
      const updated = await requestJson(`/api/human-gates/${directionGate.id}`);
      return updated.status !== "pending";
    }, "direction gate was not resolved from the UI");

    await page.goto(`${baseUrl}/#/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("page-dashboard").waitFor({ timeout: timeoutMs });
    await page.getByTestId("select-project").selectOption({ label: projectName });
    const closed = await ensureCycleClosed(page, project.id, cycle1Id);

    const cycles = await requestJson(`/api/projects/${project.id}/cycles`);
    const cycle1 = cycles.find((cycle) => cycle.idx === 1);
    assert(cycle1?.status === "closed", "cycle 1 did not close");

    const review = await requestJson(`/api/cycles/${cycle1.id}/review`);
    const agents = new Set(review.agentRuns.map((run) => run.agent));
    for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
      assert(agents.has(agent), `missing agent run: ${agent}`);
    }
    assert(review.predictions.length >= 1, "cycle 1 did not create a prediction");
    const firstClaim = review.predictions[0]?.claims?.[0];
    assert(firstClaim?.metric === "approved_review_gate_count", "cycle 1 prediction did not use onboarding claim metric");
    assert(firstClaim?.operator === ">=", "cycle 1 prediction did not use onboarding claim operator");
    assert(firstClaim?.target === 1, "cycle 1 prediction did not use onboarding claim target");
    assert(firstClaim?.expectedObservation === "approved_review_gate_count >= 1", "cycle 1 prediction did not write expected observation");
    assert(review.feedback.length >= 1, "cycle 1 did not preserve feedback input");
    assert(review.knowledgeUpdated.length >= 1, "cycle 1 did not update knowledge");
    const dashboard = await requestJson(`/api/projects/${project.id}/dashboard`);
    assert(dashboard.gateBudget.pendingBlocking <= 1, "pending blocking gates exceeded first-cycle expectation");

    await page.goto(`${baseUrl}/#/review`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("select-project").selectOption({ label: projectName });
    await page.getByTestId("page-review").waitFor({ timeout: timeoutMs });
    await page.getByTestId("text-cycle-goal").waitFor({ timeout: timeoutMs });
    const selectedCycleText = await page.getByTestId("select-cycle").locator("option:checked").textContent();
    assert(selectedCycleText?.includes("第 1 轮") && selectedCycleText.includes("已闭环"), "review UI did not select the closed first cycle");

    console.log(JSON.stringify({
      ok: true,
      projectId: project.id,
      projectName,
      cycleId: cycle1.id,
      schedulerActions: [opened.action, closed.action],
      agents: [...agents].sort(),
      predictions: review.predictions.length,
      feedback: review.feedback.length,
      knowledgeUpdated: review.knowledgeUpdated.length,
      pendingHuman: dashboard.gateBudget.pendingBlocking + dashboard.gateBudget.pendingNonBlocking,
      note: "Project was created and first cycle was advanced through UI controls.",
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`UI Onboarding E2E failed: ${error.message}`);
  process.exit(1);
});
