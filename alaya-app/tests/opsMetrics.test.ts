import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-ops-metrics-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { recordTrace } = await import("../server/trace.ts");
const { buildOpsMetrics, median, percentile, measurableClaimRatio, knowledgeReuseRate } = await import("../server/opsMetrics.ts");
const { registerRoutes } = await import("../server/routes.ts");

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "ops metrics",
    targetUser: "operators",
    redlines: "[]",
    weeklyHumanMinutes: 150,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "",
    worldModel: "",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number, eCycle: number | null) {
  storage.createCycle({
    id: `cycle_${projectId}_${idx}`,
    projectId,
    idx,
    goal: `cycle ${idx}`,
    status: "closed",
    eCycle,
    worstClaimError: eCycle,
    reasoning: "",
    version: 1,
  });
}

test("metric formula helpers handle empty and percentile cases", () => {
  assert.equal(median([]), null);
  assert.equal(percentile([], 95), null);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("ops metrics aggregate seeded SQLite rows and cross-check raw counts", () => {
  const projectId = "proj_ops_seeded";
  createProject(projectId);
  createCycle(projectId, 1, 0.6);
  createCycle(projectId, 2, 0.4);
  storage.createGate({
    id: "gate_ops_resolved",
    cycleId: `cycle_${projectId}_1`,
    type: "meaning",
    blocking: 0,
    title: "resolved",
    payload: JSON.stringify({ createdAt: "2026-06-07T00:00:00.000Z", resolvedAt: "2026-06-07T00:10:00.000Z" }),
    status: "approved",
    estimatedMinutes: 10,
    decision: "approve",
    reviewDwellMs: 12_000,
    version: 1,
  });
  storage.createGate({
    id: "gate_ops_blocking",
    cycleId: `cycle_${projectId}_2`,
    type: "risk",
    blocking: 1,
    title: "pending",
    payload: JSON.stringify({ createdAt: "2026-06-01T00:00:00.000Z" }),
    status: "pending",
    estimatedMinutes: 12,
    decision: null,
    reviewDwellMs: 8_000,
    version: 1,
  });
  storage.createPrediction({
    id: "pred_ops",
    cycleId: `cycle_${projectId}_1`,
    belief: "b",
    prediction: "p",
    action: "a",
    claims: JSON.stringify([
      { id: "m1", type: "metric_threshold", metric: "activation_rate", operator: ">=", target: 0.3, observed: 0.4, scale: 1, weight: 3 },
      { id: "q1", type: "qualitative", weight: 1 },
    ]),
    observation: "observed",
    predictionError: 0.2,
    worstClaimError: 0.2,
    errorType: "model",
    updateTarget: "knowledge",
    status: "resolved",
    knowledgeRefs: "[]",
  });
  storage.recordLlmCall({
    cycleId: `cycle_${projectId}_1`,
    agent: "orchestrator",
    promptVersion: "ops@v1",
    inputSummary: "in",
    outputSummary: "out",
    schemaValid: 1,
    retryCount: 0,
    latencyMs: 100,
    tokenCount: 20,
    inputTokenCount: 10,
    outputTokenCount: 10,
    estimatedCost: 0.02,
    ts: "2026-06-07T00:00:00.000Z",
  });
  storage.createKnowledge({
    id: "kb_ops_reused",
    projectId,
    type: "principle",
    title: "ops reused",
    content: "ops metrics knowledge",
    sourceType: "metric",
    sourceRef: "test",
    evidenceAlpha: 3,
    evidenceBeta: 1,
    confidenceScore: 0.75,
    confidenceLevel: "high",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: "2026-01-01",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 1,
    lastInjectedAt: Date.now(),
    lastVerifiedAt: null,
    lastDecayedAt: null,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: 1,
    tags: "[]",
    notes: "",
    supersededBy: null,
    semanticKey: "",
    version: 1,
  });
  recordTrace({
    projectId,
    cycleId: `cycle_${projectId}_2`,
    cycleIdx: 2,
    kind: "knowledge_injection",
    name: "test_injection",
    attributes: { injectedKnowledgeIds: ["kb_ops_reused"] },
  });

  const metrics = buildOpsMetrics(projectId);

  assert.equal(metrics.humanGateResolution.sampleSize, 1);
  assert.equal(metrics.humanGateResolution.medianMinutes, 10);
  assert.equal(metrics.decisionDwell.sampleSize, 2);
  assert.equal(metrics.decisionDwell.p50Ms, 10_000);
  assert.equal(metrics.decisionDwell.lowBlockingDwellWarning, false);
  assert.equal(metrics.llmCostPerCycle.totalCostUsd, 0.02);
  assert.equal(measurableClaimRatio(projectId).ratio, 0.5);
  assert.equal(knowledgeReuseRate(projectId).rate, 1);
  assert.equal(metrics.blockingGateBacklog.count, 1);
  assert.equal(metrics.compoundingGainProxyPerCycle[1].errorImprovement, 0.2);
  assert.equal(metrics.llmCostPerCycle.byCycle.reduce((sum, row) => sum + row.callCount, 0), storage.listLlmCalls().length);
});

test("ops metrics API returns safe nulls and zeros for empty datasets", async () => {
  const projectId = "proj_ops_empty";
  createProject(projectId);
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${projectId}/ops-metrics`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.humanGateResolution.medianMs, null);
    assert.equal(body.decisionDwell.p50Ms, null);
    assert.equal(body.decisionDwell.lowBlockingDwellWarning, false);
    assert.equal(body.measurableClaimRatio.ratio, null);
    assert.equal(body.blockingGateBacklog.count, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
