import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-injection-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { buildKnowledgeContext } = await import("../server/knowledgeInjection.ts");
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

test("knowledge injection returns an empty string for an empty knowledge base", () => {
  const projectId = "proj_injection_empty";
  createProject(projectId);

  assert.equal(buildKnowledgeContext("rollback audit preview", projectId), "");
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
