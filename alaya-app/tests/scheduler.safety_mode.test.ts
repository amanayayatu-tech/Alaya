import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-scheduler-safety-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_SAFETY_THROTTLE_EVERY_TICKS = "2";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "00:00-00:01";

const { storage, now } = await import("../server/storage.ts");
const { gateBudgetForProject, schedulerTickProject } = await import("../server/scheduler.ts");
const { runOperationalStagesAfterApprovedDirection } = await import("../server/flywheel.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");

const gateService = new HumanGateService(storage);

function approveGate(gateId: string, decision = "approve") {
  gateService.systemResolve(gateId, decision, {
    actor: "test",
    status: "approved",
    via: "test",
    reason: "test fixture approval",
  });
}

function createProject(projectId: string, weeklyHumanMinutes = 120, currentCycleIdx = 1) {
  storage.createProject({
    id: projectId,
    name: `Safety ${projectId}`,
    direction: "Keep the flywheel moving under bounded risk",
    targetUser: "operator",
    redlines: JSON.stringify(["no irreversible action without human approval"]),
    weeklyHumanMinutes,
    weeklyLlmBudgetCents: 1000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "test identity",
    worldModel: "test world model",
    currentCycleIdx,
    version: 1,
  });
}

function createCycle(projectId: string, idx = 1, status = "planning") {
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-8)}`,
    projectId,
    idx,
    goal: `cycle ${idx} goal`,
    status,
    eCycle: status === "closed" ? 0 : null,
    worstClaimError: status === "closed" ? 0 : null,
    reasoning: status === "closed" ? `closed cycle ${idx}` : "",
    version: 1,
  });
}

function createBlockingGate(projectId: string, cycleId: string, idx: number, estimatedMinutes = 8, missedWindows = 0) {
  return storage.createGate({
    id: `gate_blocking_${projectId}_${idx}`,
    cycleId,
    type: "risk",
    blocking: 1,
    title: `Blocking backlog ${idx}`,
    payload: JSON.stringify({ riskKey: `blocking_backlog_${idx}`, createdAt: now() }),
    status: "pending",
    estimatedMinutes,
    decision: null,
    missedWindows,
    version: 1,
  });
}

function humanAttentionGates(projectId: string) {
  return storage.listGates(projectId).filter((gate) => {
    if (gate.type !== "risk") return false;
    return JSON.parse(gate.payload).riskKey === "human_attention_overload";
  });
}

test("S1 safety_mode exits after blocking backlog is resolved and does not recreate human_attention_overload", async () => {
  const projectId = "proj_safety_exit_s1";
  createProject(projectId, 10);
  const cycle = createCycle(projectId);

  for (let i = 1; i <= 4; i += 1) {
    createBlockingGate(projectId, cycle.id, i);
  }

  assert.equal(gateBudgetForProject(projectId).safetyMode, false);
  const overloaded = await schedulerTickProject(projectId);
  assert.equal(overloaded.action, "safety_throttled");
  assert.equal(humanAttentionGates(projectId).length, 1);
  assert.equal(humanAttentionGates(projectId)[0].status, "pending");

  for (const gate of storage.listGates(projectId).filter((item) => item.id.startsWith(`gate_blocking_${projectId}_`))) {
    approveGate(gate.id, "approve");
  }

  const beforeRecovery = gateBudgetForProject(projectId);
  assert.equal(beforeRecovery.safetyMode, false);

  const recovered = await schedulerTickProject(projectId);
  assert.equal(recovered.action, "opened_direction_gate");
  const overloadGates = humanAttentionGates(projectId);
  assert.equal(overloadGates.length, 1);
  assert.equal(overloadGates[0].status, "resolved");
  assert.equal(gateBudgetForProject(projectId).safetyMode, false);
});

test("S2 attention backlog safety_mode throttles but still advances cycles", async () => {
  const projectId = "proj_safety_advance_s2";
  createProject(projectId);
  const cycle = createCycle(projectId);

  const opened = await schedulerTickProject(projectId);
  assert.equal(opened.action, "opened_direction_gate");
  const directionGate = storage.listGates(projectId).find((gate) => gate.cycleId === cycle.id && gate.type === "direction");
  assert.ok(directionGate);
  approveGate(directionGate.id, "approve_recommended");
  await runOperationalStagesAfterApprovedDirection(projectId, cycle.id);
  assert.equal(storage.getCycle(cycle.id)?.status, "closed");

  for (let i = 1; i <= 4; i += 1) {
    createBlockingGate(projectId, cycle.id, i, 5, 2);
  }
  assert.equal(gateBudgetForProject(projectId).safetyMode, true);

  const deferred = await schedulerTickProject(projectId);
  assert.equal(deferred.action, "safety_throttled");
  assert.equal(storage.listCycles(projectId).length, 1);

  const advanced = await schedulerTickProject(projectId);
  assert.equal(advanced.action, "safety_throttled");
  assert.equal(advanced.throttledAction, "created_next_cycle");
  assert.equal(storage.getProject(projectId)?.currentCycleIdx, 2);
  assert.equal(storage.listCycles(projectId).length, 2);
});

test("S3 compounding guard warms up early cycles but still blocks multi-round zero compounding", async () => {
  const warmupProject = "proj_compounding_warmup_s3";
  createProject(warmupProject);
  createCycle(warmupProject);

  const warmup = await schedulerTickProject(warmupProject);
  assert.equal(warmup.action, "opened_direction_gate");
  assert.equal(storage.listGates(warmupProject).some((gate) => JSON.parse(gate.payload).riskKey === "flywheel_empty_learning"), false);

  const stalledProject = "proj_compounding_block_s3";
  createProject(stalledProject, 120, 4);
  createCycle(stalledProject, 1, "closed");
  createCycle(stalledProject, 2, "closed");
  createCycle(stalledProject, 3, "closed");
  const cycle4 = createCycle(stalledProject, 4, "planning");
  storage.createGate({
    id: `gate_dir_weak_${stalledProject}`,
    cycleId: cycle4.id,
    type: "direction",
    blocking: 1,
    title: "Weak cycle 4 direction",
    payload: JSON.stringify({
      recommended: "Continue a generic automation",
      knowledgeRefs: [],
      reasoning: "Continue with the next useful feature.",
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });

  const blocked = await schedulerTickProject(stalledProject);
  assert.equal(blocked.action, "safety_mode");
  assert.match(blocked.note, /compounding guard/);
  const riskGate = storage.listGates(stalledProject).find((gate) => JSON.parse(gate.payload).riskKey === "flywheel_empty_learning");
  assert.ok(riskGate);
  assert.equal(JSON.parse(riskGate.payload).warmupCycles, 3);
});

test("S4 hard safety guard still blocks builder misdirection without advancing", async () => {
  const projectId = "proj_hard_block_s4";
  createProject(projectId);
  const cycle = createCycle(projectId);

  for (let i = 1; i <= 2; i += 1) {
    storage.createTask({
      id: `task_misdirected_${projectId}_${i}`,
      cycleId: cycle.id,
      agent: "builder",
      kind: "build",
      status: "failed",
      spec: JSON.stringify({
        createdAt: now(),
        failureType: "direction_mismatch",
        directionMismatch: true,
        diffSummary: "external tool changed the wrong target",
      }),
    });
  }

  const blocked = await schedulerTickProject(projectId);
  assert.equal(blocked.action, "safety_mode");
  assert.match(blocked.note, /builder misdirection guard/);
  assert.equal(storage.listCycles(projectId).some((item) => item.idx > 1), false);
  assert.equal(storage.listGates(projectId).some((gate) => gate.type === "direction"), false);
});
