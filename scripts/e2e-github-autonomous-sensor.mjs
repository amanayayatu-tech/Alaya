#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { inferGitHubTarget } from "./lib/github-target.mjs";

function readSecretFile(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function firstSecret(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

const baseUrl = process.env.ALAYA_E2E_BASE_URL ?? "http://127.0.0.1:5000";
const githubTarget = inferGitHubTarget();
const owner = githubTarget.owner;
const repo = githubTarget.repo;
const token = firstSecret(
  process.env.ALAYA_GITHUB_TOKEN,
  process.env.GITHUB_TOKEN,
  readSecretFile(process.env.ALAYA_GITHUB_TOKEN_FILE),
  readSecretFile(process.env.GITHUB_TOKEN_FILE),
);
const allowSkip = process.env.ALAYA_E2E_ALLOW_SKIP === "true";
const keepIssue = process.env.ALAYA_E2E_KEEP_ISSUE === "true";
const headless = process.env.ALAYA_E2E_HEADLESS !== "false";
const timeoutMs = Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 90_000);

const missing = [
  ["ALAYA_E2E_GITHUB_OWNER", owner],
  ["ALAYA_E2E_GITHUB_REPO", repo],
  ["ALAYA_GITHUB_TOKEN/GITHUB_TOKEN or *_TOKEN_FILE", token],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  const lines = [
    `GitHub Autonomous Sensor E2E not run. Missing env: ${missing.join(", ")}`,
    "Start Alaya with the background scheduler and, for private repos, a local GitHub token file:",
    "  GitHub owner/repo are inferred from Git remote origin; override with ALAYA_E2E_GITHUB_OWNER/REPO if needed.",
    "  Token is read from GITHUB_TOKEN_FILE/ALAYA_GITHUB_TOKEN_FILE or ALAYA_GITHUB_TOKEN/GITHUB_TOKEN.",
    "  ALAYA_SCHEDULER=true \\",
    "  ALAYA_SCHEDULER_INTERVAL_MS=500 \\",
    "  ALAYA_SENSOR_FEEDBACK_WINDOW_MS=1000 \\",
    "  npm --prefix alaya-app run dev",
    "Then run:",
    "  ALAYA_E2E_BASE_URL=http://127.0.0.1:5000 \\",
    "  npm run e2e:github-autonomous",
  ];
  for (const line of lines) console.error(line);
  if (allowSkip) console.log(JSON.stringify({ ok: false, skipped: true, missing }, null, 2));
  process.exit(allowSkip ? 0 : 2);
}

const runId = `alaya-github-auto-${Date.now().toString(36)}`;
let createdIssue = null;

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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
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
    throw new Error(`${options.method ?? "GET"} ${url} failed ${response.status}: ${detail}`);
  }
  return data;
}

async function appJson(path, options = {}) {
  return requestJson(`${baseUrl}${path}`, options);
}

async function githubJson(path, options = {}) {
  return requestJson(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "Alaya-Autonomous-Sensor-E2E",
      ...(options.headers ?? {}),
    },
  });
}

async function waitUntil(fn, message, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${message}.${suffix}`);
}

async function waitForApp() {
  await waitUntil(async () => {
    await appJson("/api/projects");
    return true;
  }, `Alaya app is not reachable at ${baseUrl}`);
}

async function closeIssueIfNeeded() {
  if (!createdIssue) return;
  if (keepIssue) {
    console.error(`Keeping GitHub issue #${createdIssue.number} because ALAYA_E2E_KEEP_ISSUE=true`);
    return;
  }
  try {
    await githubJson(`/issues/${createdIssue.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "closed",
        state_reason: "completed",
      }),
    });
  } catch (error) {
    console.error(`Warning: failed to close GitHub issue #${createdIssue.number}: ${error.message}`);
  }
}

async function verifyGateInUi(projectName, gate, issueNumber) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await page.goto(`${baseUrl}/#/gates`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("page-gates").waitFor({ timeout: timeoutMs });
    await page.getByTestId("select-project").selectOption({ label: projectName });
    const gateCard = page.getByTestId(`gate-${gate.id}`);
    await gateCard.waitFor({ timeout: timeoutMs });
    const visibleText = await gateCard.textContent();
    assert(visibleText.includes("github_issues"), "github_issues source was not visible in the Human Gates UI");
    assert(visibleText.includes("[redacted-email]"), "redacted email marker was not visible in the Human Gates UI");
    assert(visibleText.includes("[redacted-token]"), "redacted token marker was not visible in the Human Gates UI");
    assert(visibleText.includes(`#${issueNumber}`), "issue number was not visible in the Human Gates UI");
    assert(!visibleText.includes("alaya-autonomous@example.com"), "email was visible in the Human Gates UI");
    assert(!visibleText.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was visible in the Human Gates UI");
  } finally {
    await browser.close();
  }
}

async function main() {
  await waitForApp();

  const project = await appJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `GitHub Autonomous Sensor E2E ${runId}`,
      oneLiner: "Verify background scheduler ingests a real GitHub issue",
      targetUser: "Alaya operator",
      currentHypothesis: "A real GitHub issue should become a meaning gate without manual tick",
      neverDo: "call /scheduler/tick as an E2E shortcut",
      redlines: ["PII must be redacted before storage", "do not store GitHub tokens"],
      founderPreference: "autonomous but auditable",
      competitors: "manual issue triage",
      feedbackSources: `GitHub Issues ${owner}/${repo}`,
      weeklyHumanMinutes: 150,
      weeklyLlmBudgetCents: 100,
      firstClaimMetric: "github_issue_meaning_gate_count",
      firstClaimOperator: ">=",
      firstClaimTarget: 1,
      firstSignal: "background_scheduler_imports_github_issue_into_meaning_gate",
    }),
  });

  assert(project.firstClaimMetric === "github_issue_meaning_gate_count", "first claim metric was not persisted");
  assert(project.firstClaimOperator === ">=", "first claim operator was not persisted");
  assert(project.firstClaimTarget === 1, "first claim target was not persisted");

  await appJson(`/api/projects/${project.id}/integrations/github`, {
    method: "POST",
    body: JSON.stringify({ owner, repo, syncNow: false }),
  });

  createdIssue = await githubJson("/issues", {
    method: "POST",
    body: JSON.stringify({
      title: `[Alaya Autonomous E2E] 发布预览 preview is critical setup signal ${runId}`,
      body:
        `This is an Alaya autonomous Sensor E2E issue for run ${runId}.\n\n` +
        "The setup flow is confusing and I need 发布预览 / preview before publishing.\n" +
        "Contact: alaya-autonomous@example.com\n" +
        "Fake token for redaction test: sk-cp-abcdefghijklmnopqrstuvwxyz123456",
    }),
  });

  const cycle1Id = `cycle_1_${project.id.slice(-4)}`;
  const directionGate = await waitUntil(async () => {
    const gates = await appJson(`/api/human-gates?projectId=${project.id}`);
    return gates.find((gate) => gate.cycleId === cycle1Id && gate.type === "direction" && gate.blocking === 1 && gate.status === "pending");
  }, "background scheduler did not open the first direction gate; start the app with ALAYA_SCHEDULER=true and a short ALAYA_SCHEDULER_INTERVAL_MS");

  await appJson(`/api/human-gates/${directionGate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ rationale: `approve autonomous GitHub Sensor E2E ${runId}` }),
  });

  const externalGate = await waitUntil(async () => {
    const gates = await appJson(`/api/human-gates?projectId=${project.id}`);
    const syncError = gates.find((gate) => {
      const payload = gate.payload ?? {};
      return gate.type === "risk" && payload.riskKey === "external_feedback_sync_error" && gate.status === "pending";
    });
    if (syncError) {
      const payload = syncError.payload ?? {};
      const message = payload.error ? `: ${payload.error}` : "";
      throw new Error(`background GitHub sync created an error gate${message}`);
    }
    return gates.find((gate) => (
      gate.type === "meaning" &&
      gate.payload?.source === "github_issues" &&
      gate.payload?.externalId === `github:${owner}/${repo}#${createdIssue.number}`
    ));
  }, "background scheduler did not import the GitHub issue into a meaning gate");

  assert(externalGate.blocking === 0, "GitHub meaning gate should be non-blocking");
  assert(externalGate.status === "pending", "GitHub meaning gate should be pending");

  const quote = String(externalGate.payload?.userQuote ?? "");
  assert(!quote.includes("alaya-autonomous@example.com"), "email was not redacted from gate quote");
  assert(!quote.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was not redacted from gate quote");
  assert(quote.includes("[redacted-email]"), "redacted email marker missing");
  assert(quote.includes("[redacted-token]"), "redacted token marker missing");

  await verifyGateInUi(project.name, externalGate, createdIssue.number);

  await appJson(`/api/human-gates/${externalGate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ rationale: `approve autonomous GitHub meaning gate ${runId}` }),
  });
  const approvedKnowledge = await waitUntil(async () => {
    const knowledge = await appJson(`/api/knowledge?projectId=${project.id}`);
    return knowledge.find((item) => item.sourceRef === `github:${owner}/${repo}#${createdIssue.number}`) ?? null;
  }, "approved GitHub meaning gate did not create knowledge");
  assert(approvedKnowledge.status === "active", "approved GitHub knowledge should be active");
  assert(approvedKnowledge.humanApprovedCount >= 1, "approved GitHub knowledge missing human approval evidence");

  const review = await waitUntil(async () => {
    const cycles = await appJson(`/api/projects/${project.id}/cycles`);
    const cycle1 = cycles.find((cycle) => cycle.idx === 1);
    if (!cycle1 || cycle1.status !== "closed") return null;
    const data = await appJson(`/api/cycles/${cycle1.id}/review`);
    const feedback = data.feedback.find((item) => item.sourceRef === `github:${owner}/${repo}#${createdIssue.number}`);
    const firstClaim = data.predictions[0]?.claims?.[0];
    return feedback && firstClaim ? { cycle1, data, feedback, firstClaim } : null;
  }, "cycle review did not show a closed cycle with GitHub feedback and first-cycle prediction");

  assert(review.firstClaim.metric === "github_issue_meaning_gate_count", "cycle prediction did not use GitHub E2E claim metric");
  assert(review.firstClaim.operator === ">=", "cycle prediction did not use GitHub E2E claim operator");
  assert(review.firstClaim.target === 1, "cycle prediction did not use GitHub E2E claim target");
  const agents = new Set(review.data.agentRuns.map((run) => run.agent));
  for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
    assert(agents.has(agent), `missing agent run after GitHub autonomous close: ${agent}`);
  }
  assert(review.data.knowledgeUpdated.length >= 1, "GitHub autonomous cycle did not update knowledge");
  assert(review.feedback.sourceType === "github_issues", "review feedback sourceType mismatch");
  assert(review.feedback.sourceUrl === createdIssue.html_url, "review feedback sourceUrl mismatch");
  assert(!review.feedback.text.includes("alaya-autonomous@example.com"), "email was not redacted from feedback text");
  assert(!review.feedback.text.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was not redacted from feedback text");

  const nextDirectionGate = await waitUntil(async () => {
    const cycles = await appJson(`/api/projects/${project.id}/cycles`);
    const cycle2 = cycles.find((cycle) => cycle.idx === 2);
    if (!cycle2) return null;
    const gates = await appJson(`/api/human-gates?projectId=${project.id}`);
    const gate = gates.find((item) => item.cycleId === cycle2.id && item.type === "direction" && item.blocking === 1 && item.status === "pending");
    return gate ? { cycle2, gate } : null;
  }, "background scheduler did not create the next cycle direction gate after GitHub issue ingestion");

  const cycle2Review = await appJson(`/api/cycles/${nextDirectionGate.cycle2.id}/review`);
  const injected = cycle2Review.agentRuns.some((run) => run.knowledgeRefsUsed?.includes(approvedKnowledge.id));
  assert(injected, "approved GitHub knowledge was not injected into the next cycle");

  const dashboard = await appJson(`/api/projects/${project.id}/dashboard`);
  assert(dashboard.gateBudget.used <= dashboard.gateBudget.budget, "gate budget used minutes exceeds weekly budget");
  assert(dashboard.gateBudget.safetyMode === false, "scheduler entered safety mode during GitHub autonomous E2E");

  await closeIssueIfNeeded();

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    cycle1Id: review.cycle1.id,
    cycle2Id: nextDirectionGate.cycle2.id,
    issueNumber: createdIssue.number,
    issueUrl: createdIssue.html_url,
    directionGateId: directionGate.id,
    nextDirectionGateId: nextDirectionGate.gate.id,
    meaningGateId: externalGate.id,
    knowledgeId: approvedKnowledge.id,
    feedbackId: review.feedback.id,
    agents: [...agents].sort(),
    knowledgeUpdated: review.data.knowledgeUpdated.length,
    gateBudget: dashboard.gateBudget,
    uiVerified: true,
    note: "No /scheduler/tick endpoint was called by this script.",
  }, null, 2));
}

main().catch(async (error) => {
  await closeIssueIfNeeded();
  console.error(`GitHub Autonomous Sensor E2E failed: ${error.message}`);
  process.exit(1);
});
