import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-injection-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { buildKnowledgeContext, withKnowledgeRetrievalIdentity } = await import("../server/knowledgeInjection.ts");
const { runOrchestrator, scenarioForCycle } = await import("../server/flywheel.ts");
const { buildSystemInstructions } = await import("../server/llm.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Injection ${projectId}`,
    direction: "Validate knowledge injection",
    targetUser: "operator teams",
    redlines: JSON.stringify(["never inject polluted knowledge"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya should use proven knowledge before proposing high-risk automation.",
    worldModel: "Preview, rollback and audit knowledge changes user trust decisions.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-8)}`,
    projectId,
    idx,
    goal: scenarioForCycle(idx)?.proposedGoal ?? `cycle ${idx}`,
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function retrievalIdentity(projectId: string, cycleId: string, patch: Record<string, unknown> = {}) {
  return {
    schema: "alaya.learning_loop.retrieval_control.v1",
    projectId,
    runId: "learning-run-current",
    caseId: "case_heldout_current",
    cycleId,
    mode: "read_only",
    ...patch,
  };
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any> = {}) {
  storage.createKnowledge({
    id,
    projectId,
    type: patch.type ?? "principle",
    title: patch.title ?? `${id} rollback audit preview principle`,
    content: patch.content ?? "rollback audit preview knowledge lowers high risk automation fear",
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "injection-test",
    evidenceAlpha: patch.evidenceAlpha ?? 5,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 0.83,
    confidenceLevel: patch.confidenceLevel ?? "high",
    status: patch.status ?? "active",
    humanApprovedCount: patch.humanApprovedCount ?? 0,
    externalVerifiedCount: patch.externalVerifiedCount ?? 1,
    validFrom: "2026-06-04",
    validUntil: patch.validUntil ?? null,
    lastValidatedCycle: patch.lastValidatedCycle ?? 2,
    createdByCycle: patch.createdByCycle ?? 2,
    createdBy: patch.createdBy ?? "distiller",
    approvedBy: patch.approvedBy ?? null,
    usageCount: patch.usageCount ?? 0,
    lastInjectedAt: patch.lastInjectedAt ?? null,
    storageStrength: patch.storageStrength ?? 1,
    noveltyScore: patch.noveltyScore ?? null,
    sourceRound: patch.sourceRound ?? patch.createdByCycle ?? 2,
    tags: JSON.stringify(patch.tags ?? ["rollback", "audit", "preview"]),
    notes: patch.notes ?? "",
    supersededBy: patch.supersededBy ?? null,
    semanticKey: patch.semanticKey ?? "",
    version: 1,
  });
}

test("knowledge injection returns only active and strong unsuperseded knowledge", () => {
  const projectId = "proj_injection_status";
  createProject(projectId);
  for (const status of ["active", "strong", "quarantined", "conflict", "stale", "expired", "draft"]) {
    createKnowledge(projectId, `kb_injection_${status}`, { status });
  }
  createKnowledge(projectId, "kb_injection_superseded", { status: "active", supersededBy: "kb_keeper" });

  const context = buildKnowledgeContext("rollback audit preview", projectId, { nowMs: 1_780_000_000_000 });

  assert.match(context, /^\[PRIOR KNOWLEDGE\]/);
  assert.match(context, /kb_injection_active/);
  assert.match(context, /kb_injection_strong/);
  for (const id of ["quarantined", "conflict", "stale", "expired", "draft", "superseded"]) {
    assert.doesNotMatch(context, new RegExp(`kb_injection_${id}`));
  }
  assert.equal(storage.getKnowledge("kb_injection_active")?.usageCount, 1);
  assert.equal(storage.getKnowledge("kb_injection_active")?.lastInjectedAt, 1_780_000_000_000);
  assert.equal(storage.getKnowledge("kb_injection_quarantined")?.usageCount, 0);
});

test("read-only knowledge retrieval renders the same context without any knowledge or inject-audit mutation", () => {
  const projectId = "proj_injection_read_only";
  const cycleId = "cycle_injection_read_only";
  createProject(projectId);
  createKnowledge(projectId, "kb_injection_read_only", {
    status: "active",
    usageCount: 7,
    lastInjectedAt: 1_700_000_000_000,
  });
  const before = storage.getKnowledge("kb_injection_read_only");
  const injectAuditsBefore = storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length;

  const identity = retrievalIdentity(projectId, cycleId);
  const context = withKnowledgeRetrievalIdentity(identity, { projectId, cycleId }, () => (
    buildKnowledgeContext("rollback audit preview", projectId, {
      cycleId,
      cycleIdx: 77,
      nowMs: 1_780_000_000_000,
    })
  ));

  assert.match(context, /kb_injection_read_only/);
  assert.deepEqual(storage.getKnowledge("kb_injection_read_only"), before);
  assert.equal(
    storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length,
    injectAuditsBefore,
  );
  const trace = storage.listTraceEventsByCycle(cycleId).find((event) => event.kind === "knowledge_injection_evaluation");
  assert.ok(trace);
  const attrs = JSON.parse(trace.attributes);
  assert.equal(attrs.retrievalMode, "read_only");
  assert.equal(attrs.persistenceWritesAllowed, false);
  assert.equal(attrs.creditEligible, false);
  assert.equal(attrs.trainingEligible, false);
  assert.deepEqual(attrs.injectedKnowledgeIds, []);
  assert.deepEqual(attrs.readOnlySelectedKnowledgeIds, ["kb_injection_read_only"]);
});

test("retrieval control is only an exact mirror of a call-scoped identity", () => {
  const projectId = "proj_injection_control";
  const cycleId = "cycle_injection_control";
  const controlDir = mkdtempSync(join(tmpdir(), "alaya-injection-control-"));
  const controlPath = join(controlDir, "retrieval-control.json");
  createProject(projectId);
  createKnowledge(projectId, "kb_injection_control", { status: "active", usageCount: 3, lastInjectedAt: 1234 });
  process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH = controlPath;
  try {
    const identity = retrievalIdentity(projectId, cycleId, { caseId: "case_heldout_001" });
    writeFileSync(controlPath, JSON.stringify(identity));
    const before = storage.getKnowledge("kb_injection_control");
    const context = withKnowledgeRetrievalIdentity(identity, { projectId, cycleId }, () => (
      buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 78 })
    ));
    assert.match(context, /kb_injection_control/);
    assert.deepEqual(storage.getKnowledge("kb_injection_control"), before);
    const trace = storage.listTraceEventsByCycle(cycleId).find((event) => event.kind === "knowledge_injection_evaluation");
    assert.ok(trace);
    assert.equal(JSON.parse(trace.attributes).retrievalControlCaseId, "case_heldout_001");

    assert.throws(
      () => buildKnowledgeContext("rollback audit preview", projectId),
      /call-scoped knowledge retrieval identity is required/,
    );
  } finally {
    delete process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH;
  }
});

test("stale or mismatched retrieval identity fails before any knowledge or inject-audit mutation", async (t) => {
  const cases = [
    {
      label: "stale same-project mutating control versus current heldout identity",
      controlPatch: { runId: "learning-run-stale", caseId: "case_train_stale", cycleId: "cycle_stale", mode: "mutating" },
      identityPatch: {},
    },
    { label: "runId mismatch", controlPatch: { runId: "learning-run-stale" }, identityPatch: {} },
    { label: "caseId mismatch", controlPatch: { caseId: "case_heldout_stale" }, identityPatch: {} },
    { label: "cycleId mismatch", controlPatch: { cycleId: "cycle_stale" }, identityPatch: {} },
    { label: "projectId mismatch", controlPatch: { projectId: "proj_identity_other" }, identityPatch: { projectId: "proj_identity_other" } },
    { label: "mode mismatch", controlPatch: { mode: "mutating" }, identityPatch: {} },
    { label: "ambiguous identity keys", controlPatch: {}, identityPatch: { extraMode: "read_only" } },
  ];

  for (const [index, mismatch] of cases.entries()) {
    await t.test(mismatch.label, () => {
      const projectId = `proj_identity_mismatch_${index}`;
      const cycleId = `cycle_identity_mismatch_${index}`;
      const knowledgeId = `kb_identity_mismatch_${index}`;
      const controlDir = mkdtempSync(join(tmpdir(), "alaya-identity-mismatch-"));
      const controlPath = join(controlDir, "retrieval-control.json");
      createProject(projectId);
      createKnowledge(projectId, knowledgeId, { status: "active", usageCount: 9, lastInjectedAt: 4567 });
      const identity = retrievalIdentity(projectId, cycleId, mismatch.identityPatch);
      const control = retrievalIdentity(projectId, cycleId, mismatch.controlPatch);
      writeFileSync(controlPath, JSON.stringify(control));
      process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH = controlPath;
      const before = storage.getKnowledge(knowledgeId);
      const injectAuditsBefore = storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length;
      let caught: unknown = null;
      try {
        withKnowledgeRetrievalIdentity(identity, { projectId, cycleId }, () => (
          buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 90 + index })
        ));
      } catch (error) {
        caught = error;
      } finally {
        delete process.env.ALAYA_KNOWLEDGE_RETRIEVAL_CONTROL_PATH;
      }

      assert.deepEqual(storage.getKnowledge(knowledgeId), before);
      assert.equal(
        storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length,
        injectAuditsBefore,
      );
      assert.match(String(caught), /Knowledge retrieval (?:control|identity) .*mismatch/);
    });
  }
});

test("conflicting nested call-scoped retrieval identities fail closed", () => {
  const projectId = "proj_identity_nested";
  const cycleId = "cycle_identity_nested";
  const knowledgeId = "kb_identity_nested";
  createProject(projectId);
  createKnowledge(projectId, knowledgeId, { status: "active", usageCount: 4, lastInjectedAt: 2222 });
  const outer = retrievalIdentity(projectId, cycleId);
  const conflicting = retrievalIdentity(projectId, cycleId, { caseId: "case_heldout_conflicting" });
  const before = storage.getKnowledge(knowledgeId);
  const injectAuditsBefore = storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length;

  assert.throws(
    () => withKnowledgeRetrievalIdentity(outer, { projectId, cycleId }, () => (
      withKnowledgeRetrievalIdentity(conflicting, { projectId, cycleId }, () => (
        buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 101 })
      ))
    )),
    /Knowledge retrieval identity caseId mismatch in nested call scope/,
  );
  assert.deepEqual(storage.getKnowledge(knowledgeId), before);
  assert.equal(
    storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length,
    injectAuditsBefore,
  );
});

test("knowledge injection returns at most five knowledge items", () => {
  const projectId = "proj_injection_top5";
  createProject(projectId);
  for (let i = 1; i <= 6; i += 1) {
    createKnowledge(projectId, `kb_top5_${i}`, {
      status: "active",
      confidenceScore: 0.95 - (i * 0.01),
      content: `rollback audit preview reusable principle ${i}`,
    });
  }

  const context = buildKnowledgeContext("rollback audit preview", projectId);
  const itemCount = context.split("\n").filter((line) => line.startsWith("- ")).length;
  assert.ok(itemCount <= 5, `expected <=5 items, got ${itemCount}`);
});

test("knowledge injection context stays below the 800 token rough cap", () => {
  const projectId = "proj_injection_size";
  createProject(projectId);
  const longContent = "rollback audit preview ".repeat(400);
  for (let i = 1; i <= 5; i += 1) {
    createKnowledge(projectId, `kb_size_${i}`, {
      status: i === 1 ? "strong" : "active",
      confidenceScore: 0.9 - (i * 0.01),
      content: longContent,
    });
  }

  const context = buildKnowledgeContext("rollback audit preview", projectId);
  assert.ok(context.length / 4 < 800, `context rough tokens should be <800, got ${context.length / 4}`);
});

test("enabled mutating zero-candidate retrieval emits a bindable empty trace without knowledge or inject-audit mutation", () => {
  const projectId = "proj_injection_empty_mutating";
  const cycleId = "cycle_injection_empty_mutating";
  const caseId = "case_train_empty_mutating";
  const runId = "learning-run-empty-mutating";
  createProject(projectId);
  createKnowledge(projectId, "kb_injection_empty_mutating", {
    status: "quarantined",
    usageCount: 6,
    lastInjectedAt: 1_700_000_000_000,
  });
  const identity = retrievalIdentity(projectId, cycleId, {
    runId,
    caseId,
    mode: "mutating",
  });
  const beforeKnowledge = storage.listKnowledge(projectId);
  const injectAuditsBefore = storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length;
  const previous = {
    injection: process.env.ALAYA_KNOWLEDGE_INJECTION,
    ranking: process.env.ALAYA_KNOWLEDGE_RANKING,
    epsilon: process.env.ALAYA_INJECTION_EPSILON,
    seed: process.env.ALAYA_RUN_SEED,
  };
  process.env.ALAYA_KNOWLEDGE_INJECTION = "on";
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_INJECTION_EPSILON = "0.1";
  process.env.ALAYA_RUN_SEED = "empty-mutating-seed";
  try {
    const context = withKnowledgeRetrievalIdentity(identity, { projectId, cycleId }, () => (
      buildKnowledgeContext("rollback audit preview", projectId, {
        cycleId,
        cycleIdx: 102,
        maxTokens: 500,
      })
    ));

    assert.equal(context, "");
    assert.deepEqual(storage.listKnowledge(projectId), beforeKnowledge);
    assert.equal(
      storage.listEvents().filter((event) => event.actor === "knowledge_injection" && event.op === "inject").length,
      injectAuditsBefore,
    );
    const traces = storage.listTraceEventsByCycle(cycleId).filter((event) => event.kind === "knowledge_injection");
    assert.equal(traces.length, 1);
    const attrs = JSON.parse(traces[0].attributes);
    assert.equal(attrs.injectionDisabled, false);
    assert.equal(attrs.knowledgeInjectionMode, "on");
    assert.equal(attrs.retrievalMode, "mutating");
    assert.equal(attrs.retrievalControlSource, "scoped_identity");
    assert.equal(attrs.retrievalControlRunId, runId);
    assert.equal(attrs.retrievalControlCaseId, caseId);
    assert.equal(attrs.retrievalControlCycleId, cycleId);
    assert.equal(attrs.persistenceWritesAllowed, true);
    assert.equal(attrs.creditEligible, false);
    assert.equal(attrs.trainingEligible, false);
    assert.equal(attrs.rankingMode, "thompson");
    assert.deepEqual(attrs.perItemSample, {});
    assert.deepEqual(attrs.candidateIds, []);
    assert.deepEqual(attrs.injectedKnowledgeIds, []);
    assert.deepEqual(attrs.readOnlySelectedKnowledgeIds, []);
    assert.equal(attrs.droppedKnowledgeId, null);
    assert.equal(attrs.epsilon, 0.1);
    assert.equal(attrs.explorationSeed, `empty-mutating-seed:${cycleId}:exploration`);
    assert.equal(attrs.itemCount, 0);
  } finally {
    for (const [key, value] of Object.entries({
      ALAYA_KNOWLEDGE_INJECTION: previous.injection,
      ALAYA_KNOWLEDGE_RANKING: previous.ranking,
      ALAYA_INJECTION_EPSILON: previous.epsilon,
      ALAYA_RUN_SEED: previous.seed,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("read-only zero-candidate retrieval keeps its isolated empty evaluation trace", () => {
  const projectId = "proj_injection_empty_read_only";
  const cycleId = "cycle_injection_empty_read_only";
  createProject(projectId);
  const identity = retrievalIdentity(projectId, cycleId, {
    runId: "learning-run-empty-read-only",
    caseId: "case_heldout_empty_read_only",
  });

  const context = withKnowledgeRetrievalIdentity(identity, { projectId, cycleId }, () => (
    buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 103 })
  ));

  assert.equal(context, "");
  const traces = storage.listTraceEventsByCycle(cycleId).filter((event) => event.kind === "knowledge_injection_evaluation");
  assert.equal(traces.length, 1);
  const attrs = JSON.parse(traces[0].attributes);
  assert.equal(attrs.retrievalMode, "read_only");
  assert.equal(attrs.persistenceWritesAllowed, false);
  assert.deepEqual(attrs.candidateIds, []);
  assert.deepEqual(attrs.injectedKnowledgeIds, []);
  assert.deepEqual(attrs.readOnlySelectedKnowledgeIds, []);
});

test("mock flywheel LLM receives injected prior knowledge in the system context path", async () => {
  const projectId = "proj_injection_llm";
  createProject(projectId);
  createCycle(projectId, 4);
  createKnowledge(projectId, "kb_llm_rollback_audit", {
    status: "active",
    title: "dry run rollback audit principle",
    content: "dry run preview with rollback and audit summary changes high risk automation trust",
    confidenceScore: 0.88,
  });

  const scenario = scenarioForCycle(4);
  assert.ok(scenario);
  let captured: any;
  const fakeLlm = async (input: any) => {
    if (input.agent === "orchestrator") captured = input;
    return input.mockOutput;
  };

  await runOrchestrator(projectId, `cycle_4_${projectId.slice(-8)}`, scenario, fakeLlm);

  assert.ok(captured, "orchestrator LLM call should be captured");
  assert.match(captured.knowledgeSummary, /^\[PRIOR KNOWLEDGE\]/);
  assert.match(captured.knowledgeSummary, /kb_llm_rollback_audit/);
  assert.equal(buildSystemInstructions({ knowledgeSummary: captured.knowledgeSummary }).startsWith("[PRIOR KNOWLEDGE]"), true);
});
