import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-injection-thompson-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const {
  buildKnowledgeContext,
  rankKnowledgeCandidates,
  sampleBetaSeeded,
} = await import("../server/knowledgeInjection.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Thompson ${projectId}`,
    direction: "Validate seeded Thompson knowledge ranking",
    targetUser: "operator teams",
    redlines: JSON.stringify(["never inject polluted knowledge"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya should replay seeded knowledge ranking exactly.",
    worldModel: "Thompson sampling should favor knowledge proven by resolved decisions.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, patch: Record<string, any> = {}) {
  storage.createKnowledge({
    id,
    projectId,
    type: patch.type ?? "principle",
    title: patch.title ?? `${id} rollback audit preview principle`,
    content: patch.content ?? `${id} rollback audit preview knowledge changes a decision`,
    sourceType: patch.sourceType ?? "metric",
    sourceRef: patch.sourceRef ?? "thompson-test",
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

function candidate(id: string, evidenceAlpha: number, evidenceBeta: number) {
  return { id, evidenceAlpha, evidenceBeta } as any;
}

function selectedIds(candidates: readonly any[], seed: string, limit = 5): string[] {
  return rankKnowledgeCandidates(candidates, "thompson", seed, limit).selected.map((item: any) => item.id);
}

function injectedIds(context: string): string[] {
  return [...context.matchAll(/^- (\S+) /gm)].map((match) => match[1]);
}

test("same seed and same candidate set produce identical Thompson ordering", () => {
  const candidates = [
    candidate("kb_seed_a", 7, 2),
    candidate("kb_seed_b", 3, 3),
    candidate("kb_seed_c", 2, 7),
    candidate("kb_seed_d", 5, 1),
    candidate("kb_seed_e", 1, 5),
    candidate("kb_seed_f", 4, 2),
  ];

  const first = rankKnowledgeCandidates(candidates, "thompson", "run-seed:cycle-seed");
  const second = rankKnowledgeCandidates(candidates, "thompson", "run-seed:cycle-seed");

  assert.deepEqual(first.selected.map((item: any) => item.id), second.selected.map((item: any) => item.id));
  assert.deepEqual(first.perItemSample, second.perItemSample);
});

test("different seeds change Thompson ordering and avoid degenerate selection", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => candidate(`kb_uniform_${i}`, 1, 1));
  const orders = new Set<string>();
  const topIds = new Set<string>();

  for (let i = 0; i < 16; i += 1) {
    const ids = selectedIds(candidates, `run-seed-${i}:cycle`);
    orders.add(ids.join(","));
    topIds.add(ids[0]);
  }

  assert.ok(orders.size > 1, "different seeds should produce more than one order");
  assert.ok(topIds.size > 1, "top item should vary across fixed seed set");
});

test("high alpha knowledge is selected substantially more often than weak knowledge", () => {
  const candidates = [
    candidate("kb_strong", 30, 1),
    candidate("kb_weak", 1, 30),
    ...Array.from({ length: 10 }, (_, i) => candidate(`kb_neutral_${i}`, 2, 2)),
  ];
  let strongSelected = 0;
  let weakSelected = 0;

  for (let i = 0; i < 200; i += 1) {
    const ids = selectedIds(candidates, `frequency-seed-${i}:cycle`);
    if (ids.includes("kb_strong")) strongSelected += 1;
    if (ids.includes("kb_weak")) weakSelected += 1;
  }

  assert.ok(strongSelected > 150, `expected strong item to dominate, got ${strongSelected}`);
  assert.ok(strongSelected > weakSelected + 80, `expected strong > weak by a wide margin, got ${strongSelected} vs ${weakSelected}`);
});

test("ALAYA_KNOWLEDGE_RANKING=static preserves the pre-Thompson static order", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "static";
  const projectId = "proj_thompson_static";
  createProject(projectId);
  for (let i = 1; i <= 6; i += 1) {
    createKnowledge(projectId, `kb_static_${i}`, {
      title: `static ${i} rollback audit preview`,
      content: `rollback audit preview static ${i}`,
      evidenceAlpha: 7 - i,
      evidenceBeta: 1,
      confidenceScore: 0.96 - (i * 0.01),
    });
  }

  const context = buildKnowledgeContext("rollback audit preview", projectId, {
    cycleId: "cycle_static_ranking",
    cycleIdx: 12,
    nowMs: 1_780_000_000_000,
  });

  assert.deepEqual(injectedIds(context), [
    "kb_static_1",
    "kb_static_2",
    "kb_static_3",
    "kb_static_4",
    "kb_static_5",
  ]);
  assert.equal(context, [
    "[PRIOR KNOWLEDGE]",
    "- kb_static_1 [active] static 1 rollback audit preview",
    "  score=0.95 evidence=5.0 usage=0",
    "  rollback audit preview static 1",
    "- kb_static_2 [active] static 2 rollback audit preview",
    "  score=0.94 evidence=4.0 usage=0",
    "  rollback audit preview static 2",
    "- kb_static_3 [active] static 3 rollback audit preview",
    "  score=0.93 evidence=3.0 usage=0",
    "  rollback audit preview static 3",
    "- kb_static_4 [active] static 4 rollback audit preview",
    "  score=0.92 evidence=2.0 usage=0",
    "  rollback audit preview static 4",
    "- kb_static_5 [active] static 5 rollback audit preview",
    "  score=0.91 evidence=1.0 usage=0",
    "  rollback audit preview static 5",
    "[/PRIOR KNOWLEDGE]",
  ].join("\n"));
});

test("knowledge_injection trace includes ranking metadata while preserving existing fields", () => {
  process.env.ALAYA_KNOWLEDGE_RANKING = "thompson";
  process.env.ALAYA_RUN_SEED = "trace-seed";
  const projectId = "proj_thompson_trace";
  const cycleId = "cycle_thompson_trace";
  createProject(projectId);
  for (let i = 1; i <= 6; i += 1) {
    createKnowledge(projectId, `kb_trace_${i}`, {
      title: `trace ${i} rollback audit preview`,
      content: `rollback audit preview trace ${i}`,
      evidenceAlpha: i + 1,
      evidenceBeta: 2,
      confidenceScore: 0.8,
    });
  }

  buildKnowledgeContext("rollback audit preview", projectId, {
    cycleId,
    cycleIdx: 21,
    maxTokens: 600,
  });

  const trace = storage.listTraceEventsByCycle(cycleId).find((event) => event.kind === "knowledge_injection");
  assert.ok(trace, "knowledge injection trace should be recorded");
  const attributes = JSON.parse(trace.attributes);
  assert.equal(attributes.rankingMode, "thompson");
  assert.deepEqual(attributes.candidateIds, [
    "kb_trace_6",
    "kb_trace_5",
    "kb_trace_4",
    "kb_trace_3",
    "kb_trace_2",
    "kb_trace_1",
  ]);
  assert.equal(typeof attributes.perItemSample.kb_trace_1, "number");
  assert.equal(attributes.injectedKnowledgeIds.length, 5);
  assert.equal(attributes.itemCount, 5);
  assert.equal(attributes.maxTokens, 600);
  assert.equal(attributes.taskQueryChars, "rollback audit preview".length);
});

test("sampleBetaSeeded is pure and covers alpha=1 beta=1 boundary", () => {
  const first = sampleBetaSeeded(1, 1, "boundary-seed");
  const second = sampleBetaSeeded(1, 1, "boundary-seed");
  const different = sampleBetaSeeded(1, 1, "boundary-seed-different");

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.ok(first > 0 && first < 1, `expected beta sample in (0, 1), got ${first}`);
});
