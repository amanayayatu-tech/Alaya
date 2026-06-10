import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-speculative-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "00:00-00:01";
process.env.ALAYA_SPECULATIVE_DRAFTING = "true";
process.env.ALAYA_SPECULATIVE_BUDGET_RATIO = "1";
process.env.ALAYA_APPLY_GRACE_SECONDS = "0";
process.env.ALAYA_APPLY_STAGGER_SECONDS = "2";

const { storage, now } = await import("../server/storage.ts");
const { schedulerTickProject } = await import("../server/scheduler.ts");
const { reconcileSpeculativeAssumptions, runApplyExecutor } = await import("../server/applyExecutor.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");

const gateService = new HumanGateService(storage);

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Speculative ${projectId}`,
    direction: "Keep drafting while approval is pending",
    targetUser: "operator",
    redlines: JSON.stringify(["no apply before approval"]),
    weeklyHumanMinutes: 120,
    weeklyLlmBudgetCents: 1000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "speculative test identity",
    worldModel: "High-risk changes need preview, rollback and audit.",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_1_${projectId}`,
    projectId,
    idx: 1,
    goal: "parent waits for approval",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
  storage.createGate({
    id: `gate_dir_${projectId}`,
    cycleId: `cycle_1_${projectId}`,
    type: "direction",
    blocking: 1,
    title: "Parent direction pending",
    payload: JSON.stringify({ createdAt: now(), recommended: "Approve parent direction later" }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });
}

test("scheduler creates speculative draft instead of waiting on pending blocking gate", async () => {
  const projectId = "proj_speculative_draft";
  createProject(projectId);

  const result = await schedulerTickProject(projectId);
  assert.equal(result.action, "created_speculative_draft");
  assert.equal(result.cycleId, `cycle_1_${projectId}`);
  assert.ok(result.nextCycleId);

  const draft = storage.getCycle(result.nextCycleId!);
  assert.ok(draft);
  assert.equal(draft.speculative, 1);
  assert.equal(draft.parentCycleId, `cycle_1_${projectId}`);
  assert.equal(draft.draftStatus, "ready_awaiting_approval");
  assert.deepEqual(JSON.parse(draft.dependsOn ?? "[]"), [`cycle_1_${projectId}`]);
  assert.equal(JSON.parse(draft.assumedOutcomes ?? "[]")[0].assumed, "approved");

  const predictions = storage.listPredictions(draft.id);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0].status, "open");
  assert.equal(predictions[0].observation, null);
  assert.equal(storage.listObservations(draft.id).length, 0);

  const task = storage.listTasks(draft.id).find((item) => item.kind === "speculative_change_package");
  assert.ok(task);
  const taskSpec = JSON.parse(task.spec);
  assert.equal(task.status, "done");
  assert.equal(taskSpec.draftStatus, "ready_awaiting_approval");
  assert.ok(taskSpec.changePackage.rollbackPlan.length > 0);
  assert.ok(taskSpec.changePackage.auditSummary.length > 0);

  const gate = storage.listGates(projectId).find((item) => item.cycleId === draft.id && item.type === "risk");
  assert.ok(gate);
  assert.equal(gate.status, "pending");
  assert.equal(gate.notifyPolicy, "next_window");
  assert.equal(JSON.parse(gate.payload).riskKey, "speculative_apply_draft");

  gateService.systemResolve(gate.id, "approve", {
    actor: "test",
    status: "approved",
    via: "test",
    reason: "queue speculative draft for apply",
  });
  const queued = storage.getCycle(draft.id);
  assert.equal(queued?.draftStatus, "apply_queued");
  assert.ok(queued?.applyScheduledAt);

  const applyAt = new Date(Date.parse(queued.applyScheduledAt!) + 1);
  const applied = await runApplyExecutor(projectId, applyAt);
  assert.equal(applied.applied, 1);
  assert.deepEqual(applied.appliedCycleIds, [draft.id]);
  const observing = storage.getCycle(draft.id);
  assert.equal(observing?.draftStatus, "applied_observing");
  assert.equal(observing?.status, "running");
  assert.equal(observing?.appliedAt, applyAt.toISOString());
  assert.deepEqual(JSON.parse(observing?.coAppliedSet ?? "[]"), [draft.id]);
});

test("speculative apply can be revoked before apply and not after apply", async () => {
  const projectId = "proj_speculative_revoke";
  createProject(projectId);
  const draft = storage.createCycle({
    id: `cycle_spec_revoke_${projectId}`,
    projectId,
    idx: 2,
    goal: "queued speculative draft",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "ready for approval",
    speculative: 1,
    parentCycleId: `cycle_1_${projectId}`,
    dependsOn: JSON.stringify([`cycle_1_${projectId}`]),
    assumedOutcomes: JSON.stringify([{ cycle: `cycle_1_${projectId}`, claim: "blocking_gate_approval", assumed: "approved" }]),
    draftStatus: "ready_awaiting_approval",
    applyScheduledAt: null,
    appliedAt: null,
    coAppliedSet: null,
    version: 1,
  });
  const gate = storage.createGate({
    id: `gate_spec_revoke_${projectId}`,
    cycleId: draft.id,
    type: "risk",
    blocking: 1,
    title: "Speculative apply revoke",
    payload: JSON.stringify({ riskKey: "speculative_apply_draft", draftCycleId: draft.id, createdAt: now() }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  gateService.approve(gate.id, { actor: "human", via: "test" });
  assert.equal(storage.getCycle(draft.id)?.draftStatus, "apply_queued");

  const revoked = gateService.revoke(gate.id, { actor: "human", via: "test" });
  assert.equal(revoked.gate.status, "pending");
  assert.equal(revoked.gate.decision, "revoked");
  assert.equal(storage.getCycle(draft.id)?.draftStatus, "ready_awaiting_approval");
  assert.equal(storage.getCycle(draft.id)?.applyScheduledAt, null);
  assert.equal(storage.listActionLedger(projectId).some((row) => row.actionType === "human_gate.revoke" && row.target === gate.id), true);

  gateService.approve(gate.id, { actor: "human", via: "test" });
  const queued = storage.getCycle(draft.id);
  assert.equal(queued?.draftStatus, "apply_queued");
  await runApplyExecutor(projectId, new Date(Date.parse(queued?.applyScheduledAt ?? now()) + 1));
  assert.throws(() => gateService.revoke(gate.id, { actor: "human", via: "test" }), /cannot revoke after apply/);
});

test("wrong_direction speculative reject invalidates descendants", () => {
  const projectId = "proj_speculative_reject_cascade";
  createProject(projectId);
  const ancestor = storage.createCycle({
    id: `cycle_spec_reject_ancestor_${projectId}`,
    projectId,
    idx: 2,
    goal: "ancestor ready for reject",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "ancestor speculative draft",
    speculative: 1,
    parentCycleId: `cycle_1_${projectId}`,
    dependsOn: JSON.stringify([`cycle_1_${projectId}`]),
    assumedOutcomes: JSON.stringify([{ cycle: `cycle_1_${projectId}`, claim: "blocking_gate_approval", assumed: "approved" }]),
    draftStatus: "ready_awaiting_approval",
    applyScheduledAt: null,
    appliedAt: null,
    coAppliedSet: null,
    version: 1,
  });
  const child = storage.createCycle({
    id: `cycle_spec_reject_child_${projectId}`,
    projectId,
    idx: 3,
    goal: "child depends on rejected ancestor",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "child speculative draft",
    speculative: 1,
    parentCycleId: ancestor.id,
    dependsOn: JSON.stringify([ancestor.id]),
    assumedOutcomes: JSON.stringify([{ cycle: ancestor.id, claim: "claim_ancestor", assumed: "met" }]),
    draftStatus: "ready_awaiting_approval",
    applyScheduledAt: null,
    appliedAt: null,
    coAppliedSet: null,
    version: 1,
  });
  const ancestorGate = storage.createGate({
    id: `gate_spec_reject_ancestor_${projectId}`,
    cycleId: ancestor.id,
    type: "risk",
    blocking: 1,
    title: "Reject ancestor speculative apply",
    payload: JSON.stringify({ riskKey: "speculative_apply_draft", draftCycleId: ancestor.id, createdAt: now() }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });
  const childGate = storage.createGate({
    id: `gate_spec_reject_child_${projectId}`,
    cycleId: child.id,
    type: "risk",
    blocking: 1,
    title: "Child speculative apply",
    payload: JSON.stringify({ riskKey: "speculative_apply_draft", draftCycleId: child.id, createdAt: now() }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  gateService.reject(ancestorGate.id, { actor: "human", via: "test", reasonCode: "wrong_direction" });

  assert.equal(storage.getGate(ancestorGate.id)?.status, "rejected");
  assert.equal(storage.getGate(ancestorGate.id)?.rejectReasonCode, "wrong_direction");
  assert.equal(storage.getCycle(ancestor.id)?.draftStatus, "invalidated");
  assert.equal(storage.getCycle(child.id)?.draftStatus, "invalidated");
  assert.equal(storage.getGate(childGate.id)?.status, "modified");
  assert.equal(storage.getGate(childGate.id)?.decision, "invalidated_by_system");
  assert.equal(storage.listEvents().some((event) =>
    event.tableName === "cycles" && event.op === "speculative_chain_invalidated" && event.after.includes(child.id)), true);
});

test("speculative descendants are invalidated when an ancestor observation breaks assumptions", () => {
  const projectId = "proj_speculative_invalidate";
  createProject(projectId);
  const ancestor = storage.createCycle({
    id: `cycle_spec_ancestor_${projectId}`,
    projectId,
    idx: 2,
    goal: "ancestor applied",
    status: "running",
    eCycle: 0.82,
    worstClaimError: 0.82,
    reasoning: "applied ancestor with failed assumption",
    speculative: 1,
    parentCycleId: `cycle_1_${projectId}`,
    dependsOn: JSON.stringify([`cycle_1_${projectId}`]),
    assumedOutcomes: JSON.stringify([{ cycle: `cycle_1_${projectId}`, claim: "blocking_gate_approval", assumed: "approved" }]),
    draftStatus: "applied_observing",
    applyScheduledAt: now(),
    appliedAt: now(),
    coAppliedSet: JSON.stringify([]),
    version: 1,
  });
  storage.createPrediction({
    id: `pred_failed_${projectId}`,
    cycleId: ancestor.id,
    belief: "assumption should fail",
    prediction: "activation should meet target",
    action: "observe ancestor",
    claims: JSON.stringify([{ id: "claim_failed", type: "metric_threshold", metric: "activation_rate", operator: ">=", target: 0.8, observed: 0.1 }]),
    observation: "activation_rate = 0.1",
    predictionError: 0.82,
    worstClaimError: 0.82,
    errorType: "model",
    updateTarget: "distiller_world_model_update",
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });
  const child = storage.createCycle({
    id: `cycle_spec_child_${projectId}`,
    projectId,
    idx: 3,
    goal: "child depends on ancestor",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "child assumes ancestor met",
    speculative: 1,
    parentCycleId: ancestor.id,
    dependsOn: JSON.stringify([ancestor.id]),
    assumedOutcomes: JSON.stringify([{ cycle: ancestor.id, claim: "claim_failed", assumed: "met" }]),
    draftStatus: "ready_awaiting_approval",
    applyScheduledAt: null,
    appliedAt: null,
    coAppliedSet: null,
    version: 1,
  });
  const gate = storage.createGate({
    id: `gate_spec_child_${projectId}`,
    cycleId: child.id,
    type: "risk",
    blocking: 1,
    title: "Child speculative apply",
    payload: JSON.stringify({ riskKey: "speculative_apply_draft", draftCycleId: child.id, createdAt: now() }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  const result = reconcileSpeculativeAssumptions(projectId);
  assert.deepEqual(result.invalidatedCycleIds, [child.id]);
  assert.equal(storage.getCycle(child.id)?.draftStatus, "invalidated");
  assert.equal(storage.getGate(gate.id)?.status, "modified");
  assert.equal(storage.getGate(gate.id)?.decision, "invalidated_by_system");
});
