import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-healthz-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { registerRoutes } = await import("../server/routes.ts");
const { rawDb, storage } = await import("../server/storage.ts");
const { recordTrace } = await import("../server/trace.ts");

const app = express();
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("healthz and readyz expose distinct liveness and readiness semantics", async () => {
  const address = server.address() as AddressInfo;
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  const healthBody = await health.json() as any;
  const readyBody = await ready.json() as any;
  assert.equal(health.status, 200);
  assert.equal(healthBody.status, "ok");
  assert.equal(ready.status, 200);
  assert.equal(readyBody.status, "ready");
  assert.ok(readyBody.checks.database);
});

test("metrics endpoint emits Prometheus-style core long-run metrics", async () => {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  const text = await response.text();
  assert.equal(response.status, 200);
  for (const metric of [
    "alaya_uptime_seconds",
    "alaya_mode_info",
    "alaya_actions_total",
    "alaya_llm_requests_total",
    "alaya_llm_estimated_cost_usd_total",
    "alaya_knowledge_injections_total",
    "alaya_errors_total",
    "alaya_review_window_adherence",
    "alaya_decision_dwell_ms_p50",
    "alaya_gates_deferred_total",
    "alaya_speculative_cycles_total",
    "alaya_apply_queue_depth",
    "alaya_apply_revoked_total",
    "alaya_gray_active_count",
    "alaya_gray_demoted_total",
    "alaya_utility_confirm_total",
    "alaya_utility_refute_total",
    "alaya_utility_skipped_confounded_total",
    "alaya_sensor_errors_total",
    "alaya_distiller_proposals_total",
    "alaya_gold_regression_runs_total",
    "alaya_gold_regression_failures_total",
    "alaya_attribution_low_confidence_total",
  ]) {
    assert.match(text, new RegExp(metric));
  }
});

function createMetricsProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "metrics truth",
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
  storage.createCycle({
    id: `cycle_${projectId}`,
    projectId,
    idx: 1,
    goal: "metrics truth",
    status: "closed",
    eCycle: 0.8,
    worstClaimError: 0.8,
    reasoning: "",
    coAppliedSet: JSON.stringify(["cycle_other"]),
    version: 1,
  });
}

function createSensorAccumulator(fingerprint: string, projectId: string, count: number, baseMs: number) {
  const timestamps = Array.from({ length: count }, (_, index) => baseMs + index * 1_000);
  storage.upsertSensorErrorAccumulator({
    fingerprint,
    projectId,
    source: fingerprint.split(":")[1] ?? "source",
    errorKind: "data_missing",
    occurrenceCount: count,
    eventTimestampsMs: JSON.stringify(timestamps),
    firstSeenAt: new Date(timestamps[0]).toISOString(),
    lastSeenAt: new Date(timestamps.at(-1) ?? baseMs).toISOString(),
    version: 1,
  });
}

test("phase4 metrics match DB truth sources", async () => {
  const projectId = "proj_metrics_truth";
  const baseMs = Date.parse("2026-06-11T00:00:00.000Z");
  createMetricsProject(projectId);
  storage.createKnowledge({
    id: "kb_metrics_gray",
    projectId,
    type: "principle",
    title: "gray",
    content: "gray active knowledge",
    sourceType: "metric",
    sourceRef: "metrics",
    evidenceAlpha: 2,
    evidenceBeta: 2,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-01",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: baseMs,
    lastVerifiedAt: baseMs,
    lastDecayedAt: null,
    grayStreak: 1,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: 1,
    tags: "[]",
    notes: "",
    supersededBy: null,
    semanticKey: "",
    version: 1,
  });
  storage.createPrediction({
    id: "pred_metrics_confounded",
    cycleId: `cycle_${projectId}`,
    belief: "b",
    prediction: "p",
    action: "a",
    claims: "[]",
    observation: "observed",
    predictionError: 0.8,
    worstClaimError: 0.8,
    errorType: "model",
    updateTarget: "utility_feedback",
    status: "resolved",
    knowledgeRefs: JSON.stringify(["kb_metrics_gray"]),
  });
  recordTrace({
    projectId,
    cycleId: `cycle_${projectId}`,
    cycleIdx: 1,
    kind: "principle_transition",
    name: "knowledge_cycle_utility_feedback",
    agent: "librarian/utility_feedback",
    attributes: { eventKind: "cycle_utility_confirm" },
  });
  recordTrace({
    projectId,
    cycleId: `cycle_${projectId}`,
    cycleIdx: 1,
    kind: "principle_transition",
    name: "knowledge_cycle_utility_feedback",
    agent: "librarian/utility_feedback",
    attributes: { eventKind: "cycle_utility_refute" },
  });
  storage.recordEvent({
    cycleIdx: 1,
    actor: "librarian/gray_decay",
    tableName: "knowledge_items",
    op: "update",
    before: JSON.stringify({ id: "kb_metrics_wallclock", projectId, status: "active" }),
    after: JSON.stringify({ id: "kb_metrics_wallclock", projectId, status: "stale" }),
    ts: "2026-06-11T00:00:00.000Z",
  });
  storage.recordEvent({
    cycleIdx: 1,
    actor: "time_decay_scheduler",
    tableName: "knowledge_items",
    op: "update",
    before: JSON.stringify({ id: "kb_metrics_cycle", projectId, status: "active" }),
    after: JSON.stringify({ id: "kb_metrics_cycle", projectId, status: "stale" }),
    ts: "2026-06-11T00:00:01.000Z",
  });
  createSensorAccumulator(`${projectId}:sensor_transient:data_missing`, projectId, 3, baseMs);
  createSensorAccumulator(`${projectId}:sensor_recurring:data_missing`, projectId, 6, baseMs);
  createSensorAccumulator(`${projectId}:sensor_structural:data_missing`, projectId, 25, baseMs);
  storage.createPendingAttribution({
    id: "pa_metrics_low",
    projectId,
    fingerprint: "metrics:activation:model",
    errorType: "model",
    claimError: 0.55,
    context: "{}",
    confidence: 0.65,
    status: "pending",
    gateId: null,
    resolvedAt: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    version: 1,
  });
  storage.createDistillerProposal({
    id: "dp_metrics_gated",
    projectId,
    cycleId: `cycle_${projectId}`,
    proposalType: "create",
    targetKnowledgeId: null,
    proposedContent: "{}",
    attributionBasis: "{}",
    regressionStatus: "passed",
    regressionFailedCases: "[]",
    gateId: null,
    status: "gated",
    createdAt: "2026-06-11T00:00:00.000Z",
  });
  storage.createDistillerProposal({
    id: "dp_metrics_rejected",
    projectId,
    cycleId: `cycle_${projectId}`,
    proposalType: "create",
    targetKnowledgeId: null,
    proposedContent: "{}",
    attributionBasis: "{}",
    regressionStatus: "failed",
    regressionFailedCases: JSON.stringify(["gold_bad"]),
    gateId: null,
    status: "rejected",
    createdAt: "2026-06-11T00:00:01.000Z",
  });
  storage.recordEvent({
    cycleIdx: 1,
    actor: "distiller_proposal",
    tableName: "gold_cases",
    op: "regression_triggered",
    before: null,
    after: JSON.stringify({ proposalId: "dp_metrics_gated", goldCaseId: "gold_ok", failed: false }),
    ts: "2026-06-11T00:00:02.000Z",
  });
  storage.recordEvent({
    cycleIdx: 1,
    actor: "distiller_proposal",
    tableName: "gold_cases",
    op: "regression_triggered",
    before: null,
    after: JSON.stringify({ proposalId: "dp_metrics_rejected", goldCaseId: "gold_bad", failed: true }),
    ts: "2026-06-11T00:00:03.000Z",
  });

  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/metrics?format=json`);
  const body = await response.json() as any;
  assert.equal(body.grayActiveCount, 1);
  assert.deepEqual(body.grayDemotedTotal, { cycle: 1, wallclock: 1 });
  assert.equal(body.utilityConfirmTotal, 1);
  assert.equal(body.utilityRefuteTotal, 1);
  assert.equal(body.utilitySkippedConfoundedTotal, 1);
  assert.deepEqual(body.sensorErrorsTotal, { transient: 3, recurring: 6, structural: 25 });
  assert.equal(body.distillerProposalsTotal.gated, 1);
  assert.equal(body.distillerProposalsTotal.rejected, 1);
  assert.equal(body.goldRegressionRunsTotal, rawDb.prepare("SELECT COUNT(*) AS count FROM event_log WHERE table_name='gold_cases' AND op='regression_triggered'").get().count);
  assert.equal(body.goldRegressionFailuresTotal, 1);
  assert.equal(body.attributionLowConfidenceTotal, 1);

  const prometheus = await fetch(`http://127.0.0.1:${address.port}/metrics`).then((item) => item.text());
  assert.match(prometheus, /alaya_gray_demoted_total\{channel="wallclock"\} 1/);
  assert.match(prometheus, /alaya_sensor_errors_total\{category="structural"\} 25/);
  assert.match(prometheus, /alaya_distiller_proposals_total\{status="gated"\} 1/);
});
