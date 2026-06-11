#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-long-evolution-")), "long.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../alaya-app/server/storage.ts");
const { runFullCycle } = await import("../alaya-app/server/flywheel.ts");
const { schedulerTickProject, gateBudgetForProject } = await import("../alaya-app/server/scheduler.ts");
const { detectGoalRepetition } = await import("../alaya-app/server/stallGuard.ts");
const { HumanGateService } = await import("../alaya-app/server/humanGateService.ts");

const projectId = "proj_long_evolution_e2e";
const TOTAL_CYCLES = 24;
// Keep the human-proxy fixture inside the weekly attention guard while approving enough proposal gates to seed autonomous knowledge and merge evidence.
const MAX_HUMAN_PROXY_PROPOSAL_APPROVALS = 10;

function createProject() {
  storage.createProject({
    id: projectId,
    name: "Long Evolution E2E",
    direction: "Validate long-running autonomous Alaya evolution",
    targetUser: "owner operators running high-risk automation",
    redlines: JSON.stringify(["no irreversible action without preview, rollback and audit"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya must compound knowledge while preserving human gates and auditability.",
    worldModel: "High-risk automation adoption improves when preview, rollback, audit and clean knowledge retrieval are explicit.",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: "cycle_1_long_evolution",
    projectId,
    idx: 1,
    goal: "Validate the first high-risk automation learning loop",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function movingAverage(values, size) {
  if (values.length === 0) return 0;
  const recent = values.slice(-size);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function assertNoGoalRepetition(goals) {
  for (let i = 0; i < goals.length; i += 1) {
    for (let j = i + 1; j < goals.length; j += 1) {
      assert.equal(
        detectGoalRepetition(goals[j], [goals[i]], 0.82),
        false,
        `goal repeated between cycle ${i + 1} and ${j + 1}: ${goals[j]}`,
      );
    }
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function proposedKnowledgeIdForGate(gate) {
  const payload = parseJsonObject(gate.payload);
  if (payload.source !== "distiller_proposal") return null;
  const content = payload.proposedContent && typeof payload.proposedContent === "object"
    ? payload.proposedContent
    : {};
  return typeof content.id === "string" && content.id ? content.id : null;
}

function pendingProposalGates() {
  return storage.listGates(projectId).filter((gate) => {
    if (gate.status !== "pending") return false;
    if (gate.type !== "meaning") return false;
    return parseJsonObject(gate.payload).source === "distiller_proposal";
  });
}

function approvePendingProposalGates(remainingApprovals) {
  const service = new HumanGateService();
  const approved = [];
  const earlyWrites = [];
  for (const gate of pendingProposalGates().slice(0, Math.max(0, remainingApprovals))) {
    const proposal = storage.getDistillerProposalByGate(gate.id);
    assert.equal(proposal?.status, "gated", `proposal gate ${gate.id} must be gated before human proxy approval`);
    const proposedKnowledgeId = proposedKnowledgeIdForGate(gate);
    if (proposedKnowledgeId && storage.getKnowledge(proposedKnowledgeId)) {
      earlyWrites.push(proposedKnowledgeId);
    }
    service.approve(gate.id, {
      actor: "local_api_human_proxy",
      via: "local_api_human_proxy",
      rationale: "Long evolution E2E consumes proposal gates through the same human proxy path as live validation.",
    });
    assert.equal(storage.getGate(gate.id)?.status, "approved", `proposal gate ${gate.id} should be approved`);
    assert.equal(storage.getDistillerProposalByGate(gate.id)?.status, "applied", `proposal ${proposal?.id} should apply after approval`);
    if (proposedKnowledgeId) {
      assert.ok(storage.getKnowledge(proposedKnowledgeId), `approved proposal should create knowledge ${proposedKnowledgeId}`);
    }
    approved.push(gate.id);
  }
  assert.deepEqual(earlyWrites, [], `gated proposals must not create knowledge before approval: ${earlyWrites.join(",")}`);
  return approved;
}

async function schedulerCreateNextCycle(nextIdx) {
  const attempts = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const tick = await schedulerTickProject(projectId);
    const action = tick.action === "safety_throttled" && tick.throttledAction
      ? `${tick.action}:${tick.throttledAction}`
      : tick.action;
    attempts.push(action);
    tickActions.push(action);
    assert.notEqual(tick.action, "scenario_exhausted", `cycle ${nextIdx} must not stop on scenario exhaustion`);
    assert.notEqual(tick.action, "safety_mode", `cycle ${nextIdx} must not enter hard safety_mode: ${tick.note}`);
    if (tick.action === "created_next_cycle" || (tick.action === "safety_throttled" && tick.throttledAction === "created_next_cycle")) {
      return tick;
    }
    if (tick.action === "safety_throttled") continue;
    assert.equal(tick.action, "created_next_cycle", `scheduler should create cycle ${nextIdx}, got ${tick.action}: ${tick.note}`);
  }
  assert.fail(`scheduler did not create cycle ${nextIdx} after soft-throttle retries: ${attempts.join(", ")}`);
}

createProject();

const tickActions = [];
const approvedProposalGateIds = [];
for (let idx = 1; idx <= TOTAL_CYCLES; idx += 1) {
  const cycle = storage.listCycles(projectId).find((item) => item.idx === idx);
  assert.ok(cycle, `missing cycle ${idx}`);
  await runFullCycle(projectId, cycle.id);
  approvedProposalGateIds.push(...approvePendingProposalGates(MAX_HUMAN_PROXY_PROPOSAL_APPROVALS - approvedProposalGateIds.length));

  if (idx < TOTAL_CYCLES) {
    await schedulerCreateNextCycle(idx + 1);
  }
}

const cycles = storage.listCycles(projectId);
assert.equal(cycles.length, TOTAL_CYCLES, `${TOTAL_CYCLES} cycles should exist`);
assert.equal(cycles.every((cycle) => cycle.status === "closed"), true, `all ${TOTAL_CYCLES} cycles should be closed`);
const createdNextCycleTicks = tickActions.filter((action) => action === "created_next_cycle" || action === "safety_throttled:created_next_cycle");
const deferredThrottleTicks = tickActions.filter((action) => action === "safety_throttled");
assert.equal(createdNextCycleTicks.length, TOTAL_CYCLES - 1, `first ${TOTAL_CYCLES - 1} scheduler advances should create the next cycle`);
assert.equal(tickActions.every((action) => action !== "safety_mode"), true, "long evolution must not enter hard safety mode");

const knowledge = storage.listKnowledge(projectId);
const decisionKnowledge = knowledge.filter((item) => !item.supersededBy && ["active", "strong"].includes(item.status));
const mergeEvents = storage.listEvents().filter((event) => event.tableName === "knowledge_items" && event.op === "merge");
const librarianMergedKnowledge = knowledge.filter((item) => item.supersededBy && /Librarian merge/i.test(item.notes));
const errors = cycles.map((cycle) => cycle.eCycle).filter((value) => typeof value === "number" && Number.isFinite(value));
const goals = cycles.map((cycle) => cycle.goal);
const gateBudget = gateBudgetForProject(projectId);
const agentRuns = storage.listAgentRuns();
const pendingGates = storage.listGates(projectId).filter((gate) => gate.status === "pending");
const strong = knowledge.filter((item) => item.status === "strong");
const approvedProposalGateSet = new Set(approvedProposalGateIds);
const humanProxyProposalApprovals = storage.listActionLedger(projectId).filter((row) => (
  row.actionType === "human_gate.approve" &&
  typeof row.approvalGateId === "string" &&
  approvedProposalGateSet.has(row.approvalGateId) &&
  (row.payload ?? "").includes("local_api_human_proxy")
));

assert.equal(errors.length, TOTAL_CYCLES, "every cycle should have prediction error");
assert.equal(Math.max(...errors) <= 1, true, "prediction errors should remain normalized");
assert.equal(movingAverage(errors, 5) <= errors[0], true, "prediction error moving average should not diverge");
assertNoGoalRepetition(goals);

assert.equal(decisionKnowledge.length <= 6, true, `decision knowledge should stay bounded, got ${decisionKnowledge.length}`);
assert.equal(mergeEvents.length >= 1 || librarianMergedKnowledge.length >= 1, true, "long evolution must produce at least one librarian merge");
assert.equal(mergeEvents.every((event) => event.actor === "librarian"), true, "merge events in the event window must be audited by librarian");
assert.equal(knowledge.some((item) => item.supersededBy), true, "merged knowledge should keep supersededBy instead of being deleted");
assert.equal(strong.every((item) => item.humanApprovedCount >= 1), true, "strong knowledge must have human approval evidence");
assert.equal(approvedProposalGateIds.length >= 1, true, "proposal meaning gates should be consumed by the human proxy");
assert.equal(humanProxyProposalApprovals.length >= approvedProposalGateIds.length, true, "proposal approvals should be audited as human gate resolves");

assert.equal(gateBudget.pendingBlocking <= 1, true, "pending blocking gates should not expand");
assert.equal(gateBudget.pendingEstimatedMinutes <= gateBudget.budget * 2, true, "pending human budget should remain bounded");
assert.equal(pendingGates.filter((gate) => gate.blocking === 1).length <= 1, true, "blocking pending gates should remain bounded");

for (const idx of Array.from({ length: TOTAL_CYCLES }, (_, i) => i + 1)) {
  const runs = agentRuns.filter((run) => run.cycleIdx === idx);
  for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
    assert.ok(runs.some((run) => run.agent === agent), `missing ${agent} agent run for cycle ${idx}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  projectId,
  totalCycles: TOTAL_CYCLES,
  tickActions,
  assertions: {
    noScenarioExhausted: !tickActions.includes("scenario_exhausted"),
    boundedDecisionKnowledge: decisionKnowledge.length,
    mergeEvents: mergeEvents.length,
    librarianMergedKnowledge: librarianMergedKnowledge.length,
    errorFirst: errors[0],
    errorMovingAverageLast5: +movingAverage(errors, 5).toFixed(6),
    uniqueGoals: goals.length,
    pendingBlocking: gateBudget.pendingBlocking,
    pendingEstimatedMinutes: gateBudget.pendingEstimatedMinutes,
    approvedProposalGates: approvedProposalGateIds.length,
    pendingProposalGates: pendingProposalGates().length,
    deferredThrottleTicks: deferredThrottleTicks.length,
    strongWithHumanApproval: strong.map((item) => ({ id: item.id, humanApprovedCount: item.humanApprovedCount })),
  },
}, null, 2));
