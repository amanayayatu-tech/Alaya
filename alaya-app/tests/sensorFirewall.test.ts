import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENSOR_ACCUMULATOR_WINDOW_MS, SensorErrorKind } from "alaya-core/src/core/sensor_filter.js";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-sensor-firewall-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_SENSOR_STRUCTURAL_THRESHOLD = "20";

const { storage } = await import("../server/storage.ts");
const { assertDecisionBriefPayload, decisionBriefForGate } = await import("../server/decisionBrief.ts");
const { importBusinessSignals } = await import("../server/businessSignals.ts");
const {
  pendingAttributionFingerprint,
  recordSensorFirewallError,
  resolvePendingAttribution,
  sensorErrorFingerprint,
} = await import("../server/sensorFirewall.ts");

const baseMs = Date.parse("2026-06-11T00:00:00.000Z");

function seed(projectId: string) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "sensor firewall",
    targetUser: "operator",
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
    goal: "sensor firewall",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function recordSensorSample(projectId: string, index: number) {
  const at = baseMs + index * 2 * 60 * 60 * 1000;
  return recordSensorFirewallError({
    projectId,
    cycleId: `cycle_${projectId}`,
    source: "wearable",
    errorKind: SensorErrorKind.DataMissing,
    summary: `missing PPG sample ${index}`,
    externalId: `reading-${index}`,
    observedAt: new Date(at).toISOString(),
    currentTimeMs: at,
    sample: { device: "ppg", sensorErrorKind: "data_missing" },
  });
}

test("sensor firewall routes transient and recurring sensor errors as perception failures", () => {
  const projectId = "proj_sensor_route";
  seed(projectId);

  let decision = recordSensorSample(projectId, 0);
  for (let i = 1; i < 4; i += 1) decision = recordSensorSample(projectId, i);
  assert.equal(decision.classification, "transient");
  assert.equal(decision.perceptionFailure, true);
  assert.equal(decision.route, "update_data_source");
  assert.equal(decision.gate, null);
  assert.equal(storage.listGates(projectId).length, 0);

  decision = recordSensorSample(projectId, 4);
  assert.equal(decision.classification, "recurring");
  assert.equal(decision.perceptionFailure, true);
  assert.equal(decision.route, "update_data_source");
  assert.equal(decision.gate?.notifyPolicy, "next_window");
  assert.equal(decision.gate?.blocking, 0);
  assert.equal(JSON.parse(decision.gate?.payload ?? "{}").perceptionFailure, true);
});

test("sensor firewall creates compliant next-window structural meaning gate", () => {
  const projectId = "proj_sensor_structural";
  seed(projectId);

  let decision = recordSensorSample(projectId, 0);
  for (let i = 1; i < 20; i += 1) decision = recordSensorSample(projectId, i);

  assert.equal(decision.classification, "structural");
  assert.equal(decision.perceptionFailure, false);
  assert.equal(decision.gate?.notifyPolicy, "next_window");
  assertDecisionBriefPayload(decision.gate!);
  const brief = decisionBriefForGate(decision.gate!);
  const fingerprint = sensorErrorFingerprint(projectId, "wearable", SensorErrorKind.DataMissing);
  assert.equal(brief?.prediction.metric, `sensor_error_rate:${fingerprint}`);
  assert.equal(brief?.prediction.operator, "<=");
  assert.equal(brief?.prediction.target, 0.05);
  assert.equal(brief?.prediction.timeWindow, "修复后48h");
});

test("business signal sensor errors stay out of normal meaning-gate flow while transient", () => {
  const projectId = "proj_business_sensor_transient";
  seed(projectId);
  const rows = Array.from({ length: 4 }, (_, index) => ({
    source: "wearable_export",
    sourceId: `reading-${index}`,
    projectId,
    signalType: "health_signal",
    observedAt: new Date(baseMs + index * 60_000).toISOString(),
    payload: { sensorErrorKind: "data_missing", ppg: null },
    sensitivityLevel: "internal",
    dedupeKey: `wearable:reading-${index}`,
    riskLevel: "read_only",
  }));

  const result = importBusinessSignals(rows);
  assert.equal(result.imported, 4);
  assert.equal(result.gatesCreated, 0);
  assert.equal(result.sensorFirewallDecisions.at(-1)?.classification, "transient");
  assert.equal(storage.listFeedback(`cycle_${projectId}`).length, 4);
  assert.equal(storage.listGates(projectId).length, 0);
  assert.equal(storage.listKnowledge(projectId).length, 0);
  const accumulator = storage.getSensorErrorAccumulator(sensorErrorFingerprint(projectId, "wearable_export", SensorErrorKind.DataMissing));
  assert.equal(accumulator?.occurrenceCount, 4);
});

test("pending attributions release only after three consistent low-confidence samples", () => {
  const projectId = "proj_pending_release";
  seed(projectId);
  const input = {
    projectId,
    cycleId: `cycle_${projectId}`,
    metric: "activation_rate",
    errorType: "model" as const,
    claimError: 0.55,
    context: { claimId: "claim_activation" },
    confidence: 0.65,
    lowConfidenceReasons: ["multiple_attribution_signals", "near_model_error_threshold"],
  };

  assert.equal(resolvePendingAttribution({ ...input, currentTimeMs: baseMs }).status, "pending");
  assert.equal(resolvePendingAttribution({ ...input, currentTimeMs: baseMs + 60_000 }).status, "pending");
  const third = resolvePendingAttribution({ ...input, currentTimeMs: baseMs + 120_000 });
  assert.equal(third.status, "released");
  assert.equal(third.shouldReleaseDistiller, true);
  const fingerprint = pendingAttributionFingerprint(projectId, "activation_rate", "model");
  assert.equal(storage.listPendingAttributions(projectId, { fingerprint, status: "released" }).length, 3);
});

test("pending attributions ignore samples outside the rolling seven-day window", () => {
  const projectId = "proj_pending_window";
  seed(projectId);
  const oldMs = baseMs - SENSOR_ACCUMULATOR_WINDOW_MS - 60_000;
  const input = {
    projectId,
    cycleId: `cycle_${projectId}`,
    metric: "retention_rate",
    errorType: "model" as const,
    claimError: 0.55,
    context: { claimId: "claim_retention" },
    confidence: 0.65,
    lowConfidenceReasons: ["near_model_error_threshold"],
  };
  resolvePendingAttribution({ ...input, currentTimeMs: oldMs });
  resolvePendingAttribution({ ...input, currentTimeMs: oldMs + 30_000 });

  const current = resolvePendingAttribution({ ...input, currentTimeMs: baseMs });
  assert.equal(current.status, "pending");
  assert.equal(current.shouldReleaseDistiller, false);
});

test("pending attribution disagreement escalates to a next-window meaning gate", () => {
  const projectId = "proj_pending_disagreement";
  seed(projectId);
  const common = {
    projectId,
    cycleId: `cycle_${projectId}`,
    metric: "activation_rate",
    claimError: 0.55,
    context: { claimId: "claim_activation" },
    confidence: 0.65,
    lowConfidenceReasons: ["near_model_error_threshold"],
  };
  assert.equal(resolvePendingAttribution({ ...common, errorType: "model" as const, currentTimeMs: baseMs }).status, "pending");
  const disagreement = resolvePendingAttribution({ ...common, errorType: "value" as const, currentTimeMs: baseMs + 60_000 });

  assert.equal(disagreement.status, "gated");
  assert.equal(disagreement.shouldReleaseDistiller, false);
  assert.equal(disagreement.gate?.notifyPolicy, "next_window");
  assertDecisionBriefPayload(disagreement.gate!);
  const payload = JSON.parse(disagreement.gate?.payload ?? "{}");
  assert.equal(payload.samples.length, 2);
  assert.deepEqual(new Set(payload.samples.map((sample: any) => sample.errorType)), new Set(["model", "value"]));
  assert.equal(storage.listPendingAttributions(projectId, { status: "gated" }).length, 2);
});
