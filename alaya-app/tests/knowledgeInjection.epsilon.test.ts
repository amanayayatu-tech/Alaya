import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-injection-epsilon-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { buildKnowledgeContext, rankKnowledgeCandidates } = await import("../server/knowledgeInjection.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Epsilon ${projectId}`,
    direction: "Validate seeded epsilon knowledge exploration",
    targetUser: "operator teams",
    redlines: JSON.stringify(["never inject polluted knowledge"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya should replay seeded epsilon exploration exactly.",
    worldModel: "Epsilon exploration should produce counterfactual injection traces.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any> = {}) {
  const item = {
    id,
    projectId,
    type: patch.type ?? "principle",
    title: patch.title ?? `${id} rollback audit preview principle`,
    content: patch.content ?? `${id} rollback audit preview knowledge changes a decision`,
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "epsilon-test",
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
  };
  storage.createKnowledge(item);
  return item;
}

function createKnowledgeSet(projectId: string, prefix: string) {
  return Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    return createKnowledge(projectId, `${prefix}_${n}`, {
      title: `${prefix} ${n} rollback audit preview`,
      content: `rollback audit preview epsilon ${n}`,
      evidenceAlpha: n + 2,
      evidenceBeta: 2,
      confidenceScore: 0.96 - (n * 0.01),
    });
  });
}

function injectedIds(context: string): string[] {
  return [...context.matchAll(/^- (\S+) /gm)].map((match) => match[1]);
}

function traceAttributes(cycleId: string, index = 0) {
  const traces = storage.listTraceEventsByCycle(cycleId).filter((event) => event.kind === "knowledge_injection");
  assert.ok(traces[index], `expected knowledge injection trace at index ${index}`);
  return JSON.parse(traces[index].attributes);
}

test("ALAYA_INJECTION_EPSILON=0 never drops and injected ids match PR-L3 ranking", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_INJECTION_EPSILON = "0";
  process.env.ALAYA_RUN_SEED = "epsilon-zero-run";
  const projectId = "proj_epsilon_zero";
  const cycleId = "cycle_epsilon_zero";
  createProject(projectId);
  const candidates = createKnowledgeSet(projectId, "kb_epsilon_zero");

  const context = buildKnowledgeContext("rollback audit preview", projectId, {
    cycleId,
    cycleIdx: 31,
    nowMs: 1_780_000_000_000,
  });
  const attrs = traceAttributes(cycleId);
  const expectedIds = rankKnowledgeCandidates(candidates as any[], "thompson", `${process.env.ALAYA_RUN_SEED}:${cycleId}`)
    .selected
    .map((item: any) => item.id);

  assert.equal(attrs.epsilon, 0);
  assert.equal(attrs.droppedKnowledgeId, null);
  assert.deepEqual(attrs.injectedKnowledgeIds, expectedIds);
  assert.deepEqual(injectedIds(context), expectedIds);
});

test("ALAYA_INJECTION_EPSILON=1 always drops exactly one item from top five", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_INJECTION_EPSILON = "1";
  process.env.ALAYA_RUN_SEED = "epsilon-one-run";
  const projectId = "proj_epsilon_one";
  const cycleId = "cycle_epsilon_one";
  createProject(projectId);
  const candidates = createKnowledgeSet(projectId, "kb_epsilon_one");

  const context = buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 32 });
  const attrs = traceAttributes(cycleId);
  const topFive = rankKnowledgeCandidates(candidates as any[], "thompson", `${process.env.ALAYA_RUN_SEED}:${cycleId}`)
    .selected
    .map((item: any) => item.id);

  assert.equal(attrs.epsilon, 1);
  assert.ok(topFive.includes(attrs.droppedKnowledgeId));
  assert.equal(attrs.injectedKnowledgeIds.length, 4);
  assert.deepEqual(attrs.injectedKnowledgeIds, topFive.filter((id) => id !== attrs.droppedKnowledgeId));
  assert.doesNotMatch(context, new RegExp(`^- ${attrs.droppedKnowledgeId} `, "m"));
});

test("same seed yields reproducible droppedKnowledgeId and exploration decision", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_INJECTION_EPSILON = "1";
  process.env.ALAYA_RUN_SEED = "epsilon-repeat-run";
  const projectId = "proj_epsilon_repeat";
  const cycleId = "cycle_epsilon_repeat";
  createProject(projectId);
  createKnowledgeSet(projectId, "kb_epsilon_repeat");

  buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 33 });
  buildKnowledgeContext("rollback audit preview", projectId, { cycleId, cycleIdx: 33 });

  const first = traceAttributes(cycleId, 0);
  const second = traceAttributes(cycleId, 1);
  assert.equal(first.explorationSeed, second.explorationSeed);
  assert.equal(first.droppedKnowledgeId, second.droppedKnowledgeId);
  assert.deepEqual(first.injectedKnowledgeIds, second.injectedKnowledgeIds);
});

test("dropping writes no evidence state and does not alter knowledge lifecycle", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_INJECTION_EPSILON = "1";
  process.env.ALAYA_RUN_SEED = "epsilon-state-run";
  const projectId = "proj_epsilon_state";
  const cycleId = "cycle_epsilon_state";
  createProject(projectId);
  const candidates = createKnowledgeSet(projectId, "kb_epsilon_state");
  const before = new Map(candidates.map((item) => [item.id, storage.getKnowledge(item.id)]));

  buildKnowledgeContext("rollback audit preview", projectId, {
    cycleId,
    cycleIdx: 34,
    nowMs: 1_780_000_000_000,
  });
  const attrs = traceAttributes(cycleId);
  const dropped = storage.getKnowledge(attrs.droppedKnowledgeId);
  assert.ok(dropped, "dropped knowledge should still exist");

  for (const item of candidates) {
    const prior = before.get(item.id);
    const after = storage.getKnowledge(item.id);
    assert.equal(after?.evidenceAlpha, prior?.evidenceAlpha);
    assert.equal(after?.evidenceBeta, prior?.evidenceBeta);
    assert.equal(after?.status, prior?.status);
    assert.equal(after?.humanApprovedCount, prior?.humanApprovedCount);
    assert.equal(after?.approvedBy, prior?.approvedBy);
  }
  assert.equal(dropped.usageCount, 0);
  assert.equal(dropped.lastInjectedAt, null);

  const droppedInjectEvents = storage.listEvents().filter((event) => {
    if (event.actor !== "knowledge_injection" || event.op !== "inject") return false;
    return JSON.parse(event.after ?? "{}").id === attrs.droppedKnowledgeId;
  });
  assert.equal(droppedInjectEvents.length, 0);
});
