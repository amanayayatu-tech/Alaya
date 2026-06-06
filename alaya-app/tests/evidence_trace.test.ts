import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-evidence-trace-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { recordTrace, parseTraceEvent } = await import("../server/trace.ts");
const { recordActionProposal } = await import("../server/actionLedger.ts");
const { callLlm } = await import("../server/llm.ts");
const { runFullCycle, scenarioForCycle } = await import("../server/flywheel.ts");
const { decayStaleKnowledge } = await import("../server/scheduler.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Evidence ${projectId}`,
    direction: "Prove evidence-grounded self evolution",
    targetUser: "agent operators",
    redlines: JSON.stringify(["no unapproved destructive action"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya must trace every meaningful decision.",
    worldModel: "Rollback and audit evidence makes high-risk automation acceptable.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  const scenario = scenarioForCycle(idx);
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-8)}`,
    projectId,
    idx,
    goal: scenario?.proposedGoal ?? `cycle ${idx}`,
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any> = {}) {
  storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: patch.title ?? "Rollback audit principle",
    content: patch.content ?? "High-risk actions need rollback and audit evidence.",
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "trace-test",
    evidenceAlpha: patch.evidenceAlpha ?? 3,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 0.75,
    confidenceLevel: patch.confidenceLevel ?? "high",
    status: patch.status ?? "active",
    humanApprovedCount: patch.humanApprovedCount ?? 0,
    externalVerifiedCount: patch.externalVerifiedCount ?? 1,
    validFrom: patch.validFrom ?? "2025-01-01",
    validUntil: patch.validUntil ?? null,
    lastValidatedCycle: patch.lastValidatedCycle ?? 1,
    createdByCycle: patch.createdByCycle ?? 1,
    createdBy: patch.createdBy ?? "test",
    approvedBy: patch.approvedBy ?? null,
    usageCount: patch.usageCount ?? 0,
    lastVerifiedAt: patch.lastVerifiedAt ?? null,
    lastDecayedAt: patch.lastDecayedAt ?? null,
    storageStrength: patch.storageStrength ?? 1,
    tags: JSON.stringify(patch.tags ?? ["rollback", "audit"]),
    notes: patch.notes ?? "",
    supersededBy: patch.supersededBy ?? null,
    semanticKey: patch.semanticKey ?? "",
    version: 1,
  });
}

test("trace events can be recorded, read, and parsed", () => {
  const projectId = "proj_trace_direct";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);
  recordTrace({
    projectId,
    cycleId: cycle.id,
    cycleIdx: cycle.idx,
    kind: "cycle_state",
    name: "test_trace",
    attributes: { ok: true },
  });

  const traces = storage.listTraceEventsByCycle(cycle.id).map(parseTraceEvent);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].kind, "cycle_state");
  assert.deepEqual(traces[0].attributes, { ok: true });
});

test("model routing metadata is persisted with llm calls", async () => {
  const projectId = "proj_model_route";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);
  const previous = process.env.ALAYA_MODEL_ROUTING_JSON;
  process.env.ALAYA_MODEL_ROUTING_JSON = JSON.stringify({ sensor: { provider: "mock", model: "mock-sensor-v2" } });
  try {
    await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "route_test",
      inputSummary: "route test",
      mockOutput: { summary: "ok" },
    });
  } finally {
    if (previous == null) delete process.env.ALAYA_MODEL_ROUTING_JSON;
    else process.env.ALAYA_MODEL_ROUTING_JSON = previous;
  }

  const call = storage.listLlmCalls().at(-1);
  assert.equal(call?.provider, "mock");
  assert.equal(call?.model, "mock-sensor-v2");
  assert.equal(call?.routeReason, "routing_json_role");
  assert.ok((call?.inputTokenCount ?? 0) > 0);
  assert.ok((call?.outputTokenCount ?? 0) > 0);
  assert.equal(call?.tokenCount, (call?.inputTokenCount ?? 0) + (call?.outputTokenCount ?? 0));
});

test("destructive action without approved gate is blocked in action ledger", () => {
  const projectId = "proj_action_blocked";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);

  const action = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "main",
    payload: { destructive: true },
  });

  assert.equal(action.riskLevel, "destructive");
  assert.equal(action.requiresApproval, 1);
  assert.equal(action.status, "blocked");
  assert.ok(action.approvalGateId);
  const gate = storage.getGate(action.approvalGateId);
  assert.equal(gate?.type, "risk");
  assert.equal(gate?.blocking, 1);
});

test("rejected direction gates do not approve high-risk actions", () => {
  const projectId = "proj_action_rejected_direction";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);
  const rejectedGate = storage.createGate({
    id: "gate_rejected_direction",
    cycleId: cycle.id,
    type: "direction",
    blocking: 1,
    title: "Rejected direction",
    payload: JSON.stringify({ reason: "owner rejected" }),
    status: "rejected",
    estimatedMinutes: 10,
    decision: "reject",
    version: 1,
  });

  const action = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "main",
    payload: { destructive: true },
  });

  assert.equal(action.status, "blocked");
  assert.notEqual(action.approvalGateId, rejectedGate.id);
  assert.equal(storage.getGate(action.approvalGateId ?? "")?.type, "risk");
});

test("approved action-specific risk gate unblocks the matching proposal only", () => {
  const projectId = "proj_action_risk_gate";
  createProject(projectId);
  const cycle = createCycle(projectId, 1);

  const first = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "feature/old-a",
    payload: { destructive: true },
  });
  const second = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "feature/old-b",
    payload: { destructive: true },
  });
  assert.equal(first.status, "blocked");
  assert.equal(second.status, "blocked");
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.notEqual(first.approvalGateId, second.approvalGateId);

  storage.updateGate(first.approvalGateId ?? "", { status: "approved", decision: "approve_risk" });
  const retriedFirst = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "feature/old-a",
    payload: { destructive: true },
  });
  const retriedSecond = recordActionProposal({
    projectId,
    cycleId: cycle.id,
    actionType: "github.delete_branch",
    target: "feature/old-b",
    payload: { destructive: true },
  });

  assert.equal(retriedFirst.status, "approved");
  assert.equal(retriedFirst.approvalGateId, first.approvalGateId);
  assert.equal(retriedSecond.status, "blocked");
  assert.equal(retriedSecond.approvalGateId, second.approvalGateId);
  const firstGatePayload = JSON.parse(storage.getGate(first.approvalGateId ?? "")?.payload ?? "{}");
  const secondGatePayload = JSON.parse(storage.getGate(second.approvalGateId ?? "")?.payload ?? "{}");
  assert.equal(firstGatePayload.idempotencyKey, first.idempotencyKey);
  assert.equal(secondGatePayload.idempotencyKey, second.idempotencyKey);
});

test("round 4 emits trace evidence, rollback package, and approved action ledger", async () => {
  const projectId = "proj_round4_trace";
  createProject(projectId);

  for (let idx = 1; idx <= 4; idx += 1) {
    const cycle = createCycle(projectId, idx);
    await runFullCycle(projectId, cycle.id);
  }

  const cycle4 = storage.listCycles(projectId).find((cycle) => cycle.idx === 4);
  assert.ok(cycle4);
  const traces = storage.listTraceEventsByCycle(cycle4.id).map(parseTraceEvent);
  const kinds = new Set(traces.map((trace) => trace.kind));
  for (const kind of ["cycle_state", "agent_run", "llm_call", "knowledge_injection", "error_classification", "action_risk"]) {
    assert.equal(kinds.has(kind), true, `missing trace kind ${kind}`);
  }

  const task = storage.listTasks(cycle4.id).find((item) => item.agent === "builder");
  assert.ok(task);
  const spec = JSON.parse(task.spec);
  assert.ok(spec.rollbackPlan, "cycle 4 task should include rollback plan");
  assert.ok(spec.auditSummary, "cycle 4 task should include audit summary");
  assert.ok(spec.actionLedgerId, "cycle 4 task should reference action ledger");

  const action = storage.listActionLedger(projectId).find((item) => item.id === spec.actionLedgerId);
  assert.equal(action?.requiresApproval, 1);
  assert.equal(action?.status, "approved");
});

test("time decay writes a principle transition trace", () => {
  const projectId = "proj_decay_trace";
  createProject(projectId);
  createCycle(projectId, 1);
  createKnowledge(projectId, "kb_decay_trace", {
    confidenceScore: 0.61,
    evidenceAlpha: 2,
    evidenceBeta: 1,
    lastVerifiedAt: Date.parse("2025-01-01T00:00:00.000Z"),
    status: "active",
  });

  const result = decayStaleKnowledge(projectId, Date.parse("2026-06-04T00:00:00.000Z"), 0.5);
  assert.equal(result.decayed, 1);
  assert.equal(storage.getKnowledge("kb_decay_trace")?.status, "stale");
  const traces = storage.listTraceEventsByProject(projectId).map(parseTraceEvent);
  assert.ok(traces.some((trace) => trace.kind === "principle_transition" && trace.name === "knowledge_time_decay"));
});
