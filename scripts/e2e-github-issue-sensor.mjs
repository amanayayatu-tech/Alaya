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
const passTokenToApp = process.env.ALAYA_E2E_PASS_TOKEN_TO_APP === "true";
const headless = process.env.ALAYA_E2E_HEADLESS !== "false";
const timeoutMs = Number(process.env.ALAYA_E2E_TIMEOUT_MS ?? 45_000);

const missing = [
  ["ALAYA_E2E_GITHUB_OWNER", owner],
  ["ALAYA_E2E_GITHUB_REPO", repo],
  ["ALAYA_GITHUB_TOKEN/GITHUB_TOKEN or *_TOKEN_FILE", token],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  const lines = [
    `GitHub Sensor E2E not run. Missing env: ${missing.join(", ")}`,
    "Start Alaya locally, then run for example:",
    "  GitHub owner/repo are inferred from Git remote origin; override with ALAYA_E2E_GITHUB_OWNER/REPO if needed.",
    "  Token is read from GITHUB_TOKEN_FILE/ALAYA_GITHUB_TOKEN_FILE or ALAYA_GITHUB_TOKEN/GITHUB_TOKEN.",
    "  ALAYA_E2E_BASE_URL=http://127.0.0.1:5000 \\",
    "  npm run e2e:github",
  ];
  for (const line of lines) console.error(line);
  if (allowSkip) console.log(JSON.stringify({ ok: false, skipped: true, missing }, null, 2));
  process.exit(allowSkip ? 0 : 2);
}

const runId = `alaya-e2e-${Date.now().toString(36)}`;
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

async function githubJson(path, options = {}) {
  return requestJson(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "Alaya-Sensor-E2E",
      ...(options.headers ?? {}),
    },
  });
}

async function appJson(path, options = {}) {
  return requestJson(`${baseUrl}${path}`, options);
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
    assert(!visibleText.includes("alaya-e2e@example.com"), "email was visible in the Human Gates UI");
    assert(!visibleText.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was visible in the Human Gates UI");
  } finally {
    await browser.close();
  }
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

try {
  await appJson("/api/projects");

  const project = await appJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: `GitHub Sensor E2E ${runId}`,
      oneLiner: "Verify real GitHub issue ingestion",
      targetUser: "Alaya operator",
      currentHypothesis: "A real GitHub issue should become a meaning gate",
      neverDo: "persist raw secrets from external feedback",
      redlines: ["PII must be redacted before storage", "do not write GitHub tokens to the DB"],
      founderPreference: "auditable and conservative",
      competitors: "manual issue triage",
      feedbackSources: `GitHub Issues ${owner}/${repo}`,
      weeklyHumanMinutes: 150,
      weeklyLlmBudgetCents: 100,
      firstClaimMetric: "github_issue_meaning_gate_count",
      firstClaimOperator: ">=",
      firstClaimTarget: 1,
      firstSignal: "github_issue_becomes_meaning_gate",
    }),
  });
  assert(project.firstClaimMetric === "github_issue_meaning_gate_count", "first claim metric was not persisted");
  assert(project.firstClaimOperator === ">=", "first claim operator was not persisted");
  assert(project.firstClaimTarget === 1, "first claim target was not persisted");

  createdIssue = await githubJson("/issues", {
    method: "POST",
    body: JSON.stringify({
      title: `[Alaya E2E] 发布预览 preview is critical setup signal ${runId}`,
      body:
        `This is an Alaya Sensor E2E issue for run ${runId}.\n\n` +
        "The setup flow is confusing and I need 发布预览 / preview before publishing.\n" +
        "Contact: alaya-e2e@example.com\n" +
        "Fake token for redaction test: sk-cp-abcdefghijklmnopqrstuvwxyz123456",
    }),
  });

  await appJson(`/api/projects/${project.id}/integrations/github`, {
    method: "POST",
    body: JSON.stringify({ owner, repo, syncNow: false }),
  });

  const opened = await appJson(`/api/projects/${project.id}/scheduler/tick`, {
    method: "POST",
    body: JSON.stringify({ syncFeedback: false }),
  });
  assert(opened.action === "opened_direction_gate", `expected opened_direction_gate, got ${opened.action}`);

  const gatesAfterOpen = await appJson(`/api/human-gates?projectId=${project.id}`);
  const directionGate = gatesAfterOpen.find((gate) => gate.type === "direction" && gate.blocking === 1 && gate.status === "pending");
  assert(directionGate, "direction gate was not opened");

  await appJson(`/api/human-gates/${directionGate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ rationale: `approve GitHub Sensor E2E ${runId}` }),
  });

  const ran = await appJson(`/api/projects/${project.id}/scheduler/tick`, {
    method: "POST",
    body: JSON.stringify({
      limit: 10,
      ...(passTokenToApp ? { githubToken: token } : {}),
    }),
  });
  assert(
    ["ran_operational_stages", "waiting_feedback_window"].includes(ran.action),
    `expected scheduler to sync feedback and progress, got ${ran.action}`,
  );

  const gates = await appJson(`/api/human-gates?projectId=${project.id}`);
  const externalGate = gates.find((gate) => (
    gate.type === "meaning" &&
    gate.payload?.source === "github_issues" &&
    gate.payload?.externalId === `github:${owner}/${repo}#${createdIssue.number}`
  ));
  assert(externalGate, `missing GitHub meaning gate for issue #${createdIssue.number}`);
  assert(externalGate.blocking === 0, "GitHub meaning gate should be non-blocking");
  assert(externalGate.status === "pending", "GitHub meaning gate should be pending");

  const quote = String(externalGate.payload?.userQuote ?? "");
  assert(!quote.includes("alaya-e2e@example.com"), "email was not redacted from gate quote");
  assert(!quote.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was not redacted from gate quote");
  assert(quote.includes("[redacted-email]"), "redacted email marker missing");
  assert(quote.includes("[redacted-token]"), "redacted token marker missing");

  await verifyGateInUi(project.name, externalGate, createdIssue.number);

  await appJson(`/api/human-gates/${externalGate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ rationale: `approve GitHub meaning gate ${runId}` }),
  });
  const approvedKnowledge = (await appJson(`/api/knowledge?projectId=${project.id}`))
    .find((item) => item.sourceRef === `github:${owner}/${repo}#${createdIssue.number}`);
  assert(approvedKnowledge, "approved GitHub meaning gate did not create knowledge");
  assert(approvedKnowledge.status === "active", "approved GitHub knowledge should be active");
  assert(approvedKnowledge.humanApprovedCount >= 1, "approved GitHub knowledge missing human approval evidence");

  const cycles = await appJson(`/api/projects/${project.id}/cycles`);
  const review = await appJson(`/api/cycles/${cycles[0].id}/review`);
  const firstClaim = review.predictions[0]?.claims?.[0];
  assert(firstClaim?.metric === "github_issue_meaning_gate_count", "cycle prediction did not use GitHub E2E claim metric");
  assert(firstClaim?.operator === ">=", "cycle prediction did not use GitHub E2E claim operator");
  assert(firstClaim?.target === 1, "cycle prediction did not use GitHub E2E claim target");
  const feedback = review.feedback.find((item) => item.sourceRef === `github:${owner}/${repo}#${createdIssue.number}`);
  assert(feedback, "review feedback sourceRef missing");
  assert(feedback.sourceType === "github_issues", "review feedback sourceType mismatch");
  assert(feedback.sourceUrl === createdIssue.html_url, "review feedback sourceUrl mismatch");
  assert(!feedback.text.includes("alaya-e2e@example.com"), "email was not redacted from feedback text");
  assert(!feedback.text.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), "token was not redacted from feedback text");

  const createdNext = await appJson(`/api/projects/${project.id}/scheduler/tick`, {
    method: "POST",
    body: JSON.stringify({ syncFeedback: false }),
  });
  assert(createdNext.action === "created_next_cycle", `expected created_next_cycle, got ${createdNext.action}`);
  const openedNext = await appJson(`/api/projects/${project.id}/scheduler/tick`, {
    method: "POST",
    body: JSON.stringify({ syncFeedback: false }),
  });
  assert(openedNext.action === "opened_direction_gate", `expected opened_direction_gate, got ${openedNext.action}`);
  const nextCycles = await appJson(`/api/projects/${project.id}/cycles`);
  const cycle2 = nextCycles.find((cycle) => cycle.idx === 2);
  assert(cycle2, "cycle 2 was not created after approved GitHub knowledge");
  const cycle2Review = await appJson(`/api/cycles/${cycle2.id}/review`);
  const injected = cycle2Review.agentRuns.some((run) => run.knowledgeRefsUsed?.includes(approvedKnowledge.id));
  assert(injected, "approved GitHub knowledge was not injected into the next cycle");

  await closeIssueIfNeeded();

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    issueNumber: createdIssue.number,
    issueUrl: createdIssue.html_url,
    schedulerAction: ran.action,
    gateId: externalGate.id,
    knowledgeId: approvedKnowledge.id,
    feedbackId: feedback.id,
    cycle2Id: cycle2.id,
    uiVerified: true,
  }, null, 2));
} catch (error) {
  await closeIssueIfNeeded();
  console.error(`GitHub Sensor E2E failed: ${error.message}`);
  process.exit(1);
}
