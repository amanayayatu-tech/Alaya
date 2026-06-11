import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-distiller-proposal-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { assertDecisionBriefPayload, decisionBriefForGate } = await import("../server/decisionBrief.ts");
const {
  auditGoldCaseHealth,
  distillerProposalDigestLines,
  onCoreParameterChanged,
  proposeDistillerKnowledge,
} = await import("../server/distillerProposal.ts");
const { classifyError, routeError } = await import("alaya-core/src/core/classify_error.js");

function seed(projectId: string, idx = 1) {
  storage.createProject({
    id: projectId,
    name: projectId,
    direction: "distiller proposal",
    targetUser: "operator",
    redlines: "[]",
    weeklyHumanMinutes: 150,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "",
    worldModel: "",
    currentCycleIdx: idx,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_${projectId}`,
    projectId,
    idx,
    goal: "proposal test",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function createGoldCase(projectId: string, id: string, claimError: number, expectedRoute = "distiller_world_model_update") {
  return storage.createGoldCase({
    id,
    projectId,
    fingerprint: `${projectId}:${id}`,
    input: JSON.stringify({
      claimError,
      context: {
        perceptionFailure: false,
        executionFailure: false,
        humanFlaggedValueMismatch: false,
        isQualitative: false,
      },
    }),
    expectedErrorType: "model",
    expectedRoute,
    active: 1,
    retiredReason: null,
    lastConfirmedAt: "2026-06-11T00:00:00.000Z",
    sourceProposalId: null,
    createdAt: "2026-06-11T00:00:00.000Z",
  });
}

function proposedKnowledge(projectId: string, id: string) {
  return {
    id,
    projectId,
    type: "world_model",
    title: `World model ${id}`,
    content: "Operators need visible boundaries before trusting automation.",
    sourceType: "agent_observation",
    sourceRef: "proposal-test",
    evidenceAlpha: 1.5,
    evidenceBeta: 1,
    confidenceScore: 0.6,
    confidenceLevel: "medium",
    status: "draft",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["proposal", "world_model"]),
    notes: "proposal test",
    semanticKey: `semantic_${id}`,
    version: 1,
  };
}

function attributionBasis(confidence = 0.96) {
  return {
    errorType: "model" as const,
    claimError: 0.8,
    contextSnapshot: {
      perceptionFailure: false,
      executionFailure: false,
      humanFlaggedValueMismatch: false,
      isQualitative: false,
    },
    attributionConfidence: confidence,
    route: "distiller_world_model_update",
    sampleFingerprints: ["sample_fp_1"],
  };
}

test("proposal state machine passes regression, gates, approves and applies via knowledge_write", () => {
  const projectId = "proj_dp_apply";
  seed(projectId);
  createGoldCase(projectId, "gold_apply", 0.8);

  const result = proposeDistillerKnowledge({
    projectId,
    cycleId: `cycle_${projectId}`,
    proposedContent: proposedKnowledge(projectId, "kb_dp_apply"),
    attributionBasis: attributionBasis(),
  });

  assert.equal(result.proposal.status, "gated");
  assert.equal(result.proposal.regressionStatus, "passed");
  assert.equal(result.regression.testedCases, 1);
  assert.ok(result.gate);
  assert.equal(result.gate?.notifyPolicy, "next_window");
  assert.equal(result.gate?.blocking, 0);
  assertDecisionBriefPayload(result.gate!);
  assert.equal(decisionBriefForGate(result.gate!)?.prediction.metric, `distiller_proposal_regression:${result.proposal.id}`);
  assert.equal(storage.listKnowledge(projectId).length, 0, "gated proposal must not create knowledge early");

  new HumanGateService().approve(result.gate!.id, { actor: "tester", via: "unit" });
  const applied = storage.getDistillerProposal(result.proposal.id);
  assert.equal(applied?.status, "applied");
  const knowledge = storage.getKnowledge("kb_dp_apply");
  assert.ok(knowledge);
  assert.equal(knowledge.status, "active");
  assert.equal(knowledge.createdBy, "distiller_proposal");
  assert.equal(knowledge.approvedBy, "tester");
  assert.equal(knowledge.humanApprovedCount, 1);
  assert.ok(storage.listActionLedger(projectId).some((row) => row.actionType === "capability.knowledge_write"));
  assert.ok(storage.listEvents().some((event) => (
    event.tableName === "distiller_proposals" &&
    event.op === "update" &&
    (event.after ?? "").includes('"status":"approved"')
  )));

  const nominated = storage.listGoldCases(projectId, { active: false, sourceProposalId: result.proposal.id });
  assert.equal(nominated.length, 1);
  assert.equal(nominated[0].active, 0);
});

test("regression failure rejects proposal and records failed gold case ids without knowledge writes", () => {
  const projectId = "proj_dp_reject_regression";
  seed(projectId);
  createGoldCase(projectId, "gold_bad_route", 0.8, "human_meaning_or_direction_gate");

  const result = proposeDistillerKnowledge({
    projectId,
    cycleId: `cycle_${projectId}`,
    proposedContent: proposedKnowledge(projectId, "kb_dp_failed"),
    attributionBasis: attributionBasis(),
  });

  assert.equal(result.proposal.status, "rejected");
  assert.equal(result.proposal.regressionStatus, "failed");
  assert.deepEqual(JSON.parse(result.proposal.regressionFailedCases ?? "[]"), ["gold_bad_route"]);
  assert.equal(result.gate, null);
  assert.equal(storage.listKnowledge(projectId).length, 0);
  assert.ok(storage.listEvents().some((event) => (
    event.tableName === "distiller_proposals" &&
    event.op === "regression_failed" &&
    (event.after ?? "").includes("gold_bad_route")
  )));
});

test("human rejection rejects gated proposal and keeps knowledge unchanged", () => {
  const projectId = "proj_dp_human_reject";
  seed(projectId);
  createGoldCase(projectId, "gold_reject", 0.8);
  const result = proposeDistillerKnowledge({
    projectId,
    cycleId: `cycle_${projectId}`,
    proposedContent: proposedKnowledge(projectId, "kb_dp_human_reject"),
    attributionBasis: attributionBasis(0.8),
  });

  new HumanGateService().reject(result.gate!.id, {
    actor: "tester",
    via: "unit",
    reasonCode: "weak_evidence",
    rationale: "not enough evidence",
  });

  assert.equal(storage.getDistillerProposal(result.proposal.id)?.status, "rejected");
  assert.equal(storage.listKnowledge(projectId).length, 0);
});

test("parameter retirement is targeted by MODEL_ERROR_THRESHOLD and unknown params create digest review task", () => {
  const projectId = "proj_gold_retire";
  seed(projectId);
  const outsideLow = createGoldCase(projectId, "gold_low", 0.45);
  const inside = createGoldCase(projectId, "gold_inside", 0.55);
  const outsideHigh = createGoldCase(projectId, "gold_high", 0.65);

  const result = onCoreParameterChanged("MODEL_ERROR_THRESHOLD", 0.5, 0.6, [outsideLow, inside, outsideHigh]);
  assert.deepEqual(result.retiredCaseIds, ["gold_inside"]);
  assert.equal(storage.getGoldCase("gold_inside")?.active, 0);
  assert.match(storage.getGoldCase("gold_inside")?.retiredReason ?? "", /MODEL_ERROR_THRESHOLD/);
  assert.equal(storage.getGoldCase("gold_low")?.active, 1);
  assert.equal(storage.getGoldCase("gold_high")?.active, 1);
  assert.equal(storage.listGoldCases(projectId).length, 3, "retirement must not physically delete gold cases");

  const unknown = onCoreParameterChanged("UNKNOWN_CORE_PARAM", 1, 2, [outsideLow, outsideHigh]);
  assert.equal(unknown.reviewTaskCreated, true);
  assert.equal(storage.getGoldCase("gold_low")?.active, 1);
  assert.ok(distillerProposalDigestLines(projectId).some((line) => line.includes("金集参数复核")));
});

test("gold case health audit reports stale, never triggered and unexpected inactive cases into digest", () => {
  const projectId = "proj_gold_health";
  seed(projectId);
  storage.createGoldCase({
    id: "gold_stale",
    projectId,
    fingerprint: "stale",
    input: JSON.stringify({ claimError: 0.8, context: {} }),
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    active: 1,
    retiredReason: null,
    lastConfirmedAt: "2026-01-01T00:00:00.000Z",
    sourceProposalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.createGoldCase({
    id: "gold_never",
    projectId,
    fingerprint: "never",
    input: JSON.stringify({ claimError: 0.8, context: {} }),
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    active: 1,
    retiredReason: null,
    lastConfirmedAt: null,
    sourceProposalId: null,
    createdAt: "2026-06-11T00:00:00.000Z",
  });
  storage.createGoldCase({
    id: "gold_inactive_bad",
    projectId,
    fingerprint: "inactive",
    input: JSON.stringify({ claimError: 0.8, context: {} }),
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    active: 0,
    retiredReason: null,
    lastConfirmedAt: null,
    sourceProposalId: null,
    createdAt: "2026-06-11T00:00:00.000Z",
  });

  const audit = auditGoldCaseHealth(projectId, storage, new Date("2026-06-11T00:00:00.000Z"));
  assert.equal(audit.issueCount, 3);
  assert.deepEqual(new Set(audit.issues.map((issue) => issue.kind)), new Set(["stale_confirmation", "never_triggered", "unexpected_inactive"]));
  assert.ok(distillerProposalDigestLines(projectId).some((line) => line === "金集健康：3 项待复核"));
});

test("classification and routing baseline remains unchanged", () => {
  const ctx = {
    perceptionFailure: false,
    executionFailure: false,
    humanFlaggedValueMismatch: false,
    isQualitative: false,
  };
  assert.equal(classifyError(0.500001, ctx), "model");
  assert.equal(classifyError(0.5, ctx), null);
  assert.equal(routeError("model"), "distiller_world_model_update");
  assert.equal(routeError(null), "no_action_or_meaning_gate");
});
