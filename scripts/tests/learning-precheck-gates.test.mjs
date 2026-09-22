import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES,
  EXCLUDED_COMPRESSED_DURATION_GATES,
  REQUIRED_LEARNING_MODEL_CALLING_AGENTS,
  buildArmPrecheckEvidence,
  classifyCompressedAnalyzerChecks,
  evaluateCompressedLearningPrecheck,
  summarizeLearningGovernanceAudit,
  summarizeModelCallInventory,
  validCompressedAnalyzerClassification,
} from "../lib/learning-precheck-gates.mjs";

const CANONICAL_ANALYZER_CHECK_NAMES = Object.freeze([
  "deltaReached8", "activeNeverZero", "tokenSourceProviderAtLeast95pct",
  "semanticContradictionBypassZero", "conflictAtLeast5", "conflictResolvedAtLeast3",
  "humanGateDropAtLeast30pct", "stallGuardUnder5pct", "sampleFailedZero",
  "durationAtLeast24h", "metricsSnapshotsAtLeast48", "uniqueConstraintErrorsZero",
  "closedDraftingRowsZero", "runnerCrashedZero", "errorLevelEventsZero", "watchdogAllGreen",
  "grayTrendExplained", "countersMonotonic", "snapshotDbGrayMatches",
  "snapshotDbErrorsMatchesOrExceeds", "meaningGateBudgetWithinWeeklyLimit",
  "phase1GrayEventsPresent", "phase2SensorCountersPresent", "phase3ProposalCountersPresent",
  "decisionTsr", "resolutionAccuracy", "confidenceCalibration", "faithfulness",
  "learningCurve", "cumulativeRegret", "knowledgeROI", "learningGovernanceAudit",
  "heldOutAccuracy", "forgettingRate", "latencyAndEfficiency", "rssSlopeUnder50MbPerHour",
]);

function analyzerBinding(replicateId) {
  return {
    invocationNonce: `nonce-${replicateId}`,
    expectedReplicateId: replicateId,
    actualReplicateId: replicateId,
    generatedAt: "2026-07-10T08:00:01.000Z",
    sourceDigest: `sha256:${replicateId}`,
  };
}

function completeAnalyzerClassification(replicateId) {
  return classifyCompressedAnalyzerChecks(
    CANONICAL_ANALYZER_CHECK_NAMES.map((name) => [name, {
      status: ["durationAtLeast24h", "metricsSnapshotsAtLeast48"].includes(name) ? "FAIL" : "PASS",
    }]),
    analyzerBinding(replicateId),
  );
}

function expectedCases() {
  return Array.from({ length: 120 }, (_, index) => ({
    id: `case_${String(index + 1).padStart(3, "0")}`,
    pool: index < 96 ? "train" : "heldout",
    groundTruthDecision: index % 2 === 0 ? "increase_long" : "reduce_exposure",
  }));
}

function rawArm(arm) {
  const cases = expectedCases();
  const events = [];
  const modelCalls = ["orchestrator", "sensor", "builder", "distiller", "librarian"].map((agent, index) => ({
    id: index + 1,
    cycleId: `${arm}_inventory_cycle_${index + 1}`,
    agent,
    provider: "openai",
    model: "MiniMax-M3",
    tokenSource: "provider",
    schemaValid: 1,
    llmFailureType: null,
    inputTokenCount: 100,
    outputTokenCount: 25,
    tokenCount: 125,
    estimatedCost: 0.01,
  }));
  const modelCallInventory = summarizeModelCallInventory({
    modelCalls,
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents: [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS],
  });
  for (const [index, testCase] of cases.entries()) {
    const cycleId = `${arm}_cycle_${String(index + 1).padStart(3, "0")}`;
    const heldout = testCase.pool === "heldout";
    events.push({
      eventType: "learning_case_resolved",
      ordinal: index + 1,
      caseId: testCase.id,
      cycleId,
      pool: testCase.pool,
      predictedDecision: testCase.groundTruthDecision,
      groundTruthDecision: testCase.groundTruthDecision,
      correctnessMode: "truth",
      calibrationTruth: { mode: "decision_matches_expected" },
      parseStatus: "ok",
      excludeFromDistiller: heldout,
      excludeFromCreditTraining: heldout,
      binding: { status: "bound", cycleId, predictionId: `${arm}_pred_${index + 1}` },
      knowledgeInjection: arm === "baseline"
        ? { traceEventId: `${arm}_trace_${index + 1}`, injectedKnowledgeIds: [], candidateIds: [], rankingMode: "static", epsilon: 0, injectionDisabled: true, retrievalMode: heldout ? "read_only" : "mutating", creditEligible: false, trainingEligible: false }
        : { traceEventId: `${arm}_trace_${index + 1}`, injectedKnowledgeIds: [], candidateIds: [], rankingMode: "thompson", epsilon: 0.1, injectionDisabled: false, retrievalMode: heldout ? "read_only" : "mutating", creditEligible: !heldout, trainingEligible: !heldout },
      llmCall: {
        provider: "openai",
        model: "MiniMax-M3",
        tokenSource: "provider",
        schemaValid: 1,
        llmFailureType: null,
      },
    });
    if (heldout) {
      events.push({
        eventType: "heldout_write_filter",
        caseId: testCase.id,
        cycleId,
        status: "applied",
        blockedPaths: ["knowledge_retrieval_mutation", "feedback_import", "distiller", "prediction_resolution", "knowledge_credit", "roi_training"],
        knowledgeStateInvariant: { passed: true },
        knowledgeRetrievalMode: "read_only",
        knowledgeInjectMutationEventCount: 0,
        predictionResolutionSkipped: true,
        knowledgeCreditEventCount: 0,
      });
    }
  }
  return {
    arm,
    summary: {
      assessmentSource: "natural_runtime_summary",
      assessment: {
        criteria: { tokenSourceProviderAtLeast95pct: true },
        observed: {
          lastLlmTokenSourceStats: { providerRatio: 0.98, label: "mixed_provider_98pct" },
        },
      },
      scenario: {
        runId: `pair-001-${arm}`,
        learningCaseCount: 120,
        learningCasesEmitted: 120,
      },
      llmProvider: "openai",
      model: "MiniMax-M3",
      finalDrain: {
        status: "complete",
        learningCaseQueue: { status: "complete", totalCases: 120, emittedCases: 120, queuedCaseCount: 0 },
      },
    },
    qualitySummary: {
      knowledgeROI: {
        eligiblePool: "train",
        trainingOutcomeCaseIds: cases.filter((testCase) => testCase.pool === "train").map((testCase) => testCase.id),
      },
      latencyAndEfficiency: {
        totals: { totalTokens: 123456, totalCostUsd: 1.25 },
      },
      modelCallInventory,
    },
    events,
    watchdogRows: [{ ok: true }, { ok: true }],
    analyzerArtifactsComplete: true,
    analyzerClassification: completeAnalyzerClassification(`pair-001-${arm}`),
    analyzerExpectation: {
      expectedInvocationNonce: `nonce-pair-001-${arm}`,
      expectedReplicateId: `pair-001-${arm}`,
      expectedSourceDigest: `sha256:pair-001-${arm}`,
      startedAtMs: Date.parse("2026-07-10T08:00:00.000Z"),
      classificationMtimeMs: Date.parse("2026-07-10T08:00:02.000Z"),
    },
    analyzerSchemaErrorCount: 0,
    drillDownReviews: cases.slice(0, 10).map((testCase) => ({
      caseId: testCase.id,
      verified: true,
      promptVerified: true,
      groundTruthVerified: true,
      modelDecisionVerified: true,
      scoringVerified: true,
    })),
    governanceAudit: {
      creditAuditComplete: true,
      rankingAuditComplete: true,
      epsilonAuditComplete: true,
      humanStrongBypassCount: 0,
      pollutedHighRiskInjectionCount: 0,
    },
    credentialsValid: true,
  };
}

function passingEvidence() {
  return ["baseline", "treatment"].map((arm) => buildArmPrecheckEvidence(rawArm(arm)));
}

function evaluate(arms = passingEvidence()) {
  return evaluateCompressedLearningPrecheck({ expectedCases: expectedCases(), arms });
}

test("compressed evaluator passes a complete frozen non-duration gate fixture and excludes only duration gates", () => {
  const result = evaluate();

  assert.equal(result.ok, true);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.excludedDurationGates, [...EXCLUDED_COMPRESSED_DURATION_GATES]);
  assert.deepEqual(result.excludedDurationGates, [
    "single_continuous_24h_directory",
    "metrics_snapshots_at_least_48",
  ]);
  assert.equal(result.legacyConflictChecks, "not_part_of_frozen_prereg_section_5");
});

test("compressed evaluator fails incomplete or unequal pairing, heldout undercoverage, parse errors, and remaining queue", () => {
  const unequal = passingEvidence();
  unequal[1].emittedCaseIds[50] = "different_case_id";
  assert.equal(evaluate(unequal).pairedSequence.status, "FAIL");

  const incomplete = passingEvidence();
  incomplete[1].rows = incomplete[1].rows.slice(0, 112);
  incomplete[1].emittedCaseIds = incomplete[1].emittedCaseIds.slice(0, 112);
  incomplete[1].summary.scenario.learningCasesEmitted = 112;
  incomplete[1].finalDrain.learningCaseQueue = { status: "incomplete", queuedCaseCount: 8 };
  const incompleteResult = evaluate(incomplete);
  assert.equal(incompleteResult.arms.treatment.gates.exact_case_sequence.status, "FAIL");
  assert.equal(incompleteResult.arms.treatment.gates.watchdog_and_final_drain.status, "FAIL");

  const heldoutLow = passingEvidence();
  for (const row of heldoutLow[1].rows.filter((row) => row.pool === "heldout").slice(0, 5)) row.predictedDecision = null;
  assert.equal(evaluate(heldoutLow).arms.treatment.gates.scored_coverage.status, "FAIL");

  const parseError = passingEvidence();
  parseError[0].errorCounts.parse_error = 1;
  assert.equal(evaluate(parseError).arms.baseline.gates.error_gates_zero.status, "FAIL");
});

test("compressed evaluator fails heldout leakage, provider/trace/analyzer errors, missing usage, and missing drilldown", () => {
  const leakage = passingEvidence();
  leakage[1].isolation.violations.push("case_097:knowledge_credit");
  assert.equal(evaluate(leakage).arms.treatment.gates.heldout_isolation.status, "FAIL");

  for (const errorName of ["provider_contract_error", "trace_schema_error", "analyzer_schema_error"]) {
    const arms = passingEvidence();
    arms[0].errorCounts[errorName] = 1;
    assert.equal(evaluate(arms).arms.baseline.gates.error_gates_zero.status, "FAIL", errorName);
  }

  const missingUsage = passingEvidence();
  missingUsage[0].usageMetadata.replicateId = null;
  assert.equal(evaluate(missingUsage).arms.baseline.gates.usage_metadata.status, "FAIL");

  const missingDrilldown = passingEvidence();
  missingDrilldown[0].drillDown.verified = 9;
  assert.equal(evaluate(missingDrilldown).arms.baseline.gates.manual_drilldown_at_least_10.status, "FAIL");
});

test("provider route ratio 1.0 and token-source ratio 0.95 remain distinct literal thresholds", () => {
  const badRoute = passingEvidence();
  badRoute[0].providerRouteRatio = 0.99;
  badRoute[0].tokenSourceProviderRatio = 0.99;
  const routeGate = evaluate(badRoute).arms.baseline.gates.provider_and_token_source;
  assert.equal(routeGate.status, "FAIL");
  assert.equal(routeGate.observed.providerRouteThreshold, 1);
  assert.equal(routeGate.observed.tokenSourceProviderThreshold, 0.95);

  const badTokenSource = passingEvidence();
  badTokenSource[0].providerRouteRatio = 1;
  badTokenSource[0].tokenSourceProviderRatio = 0.94;
  assert.equal(evaluate(badTokenSource).arms.baseline.gates.provider_and_token_source.status, "FAIL");
});

test("provider inventory covers every model-calling agent and catches non-learning agent drift", () => {
  const arms = passingEvidence();
  const driftedCalls = arms[1].modelCallInventory.calls.map((call) => ({ ...call }));
  const sensor = driftedCalls.find((call) => call.agent === "sensor");
  sensor.model = "unexpected-model";
  arms[1].modelCallInventory = summarizeModelCallInventory({
    modelCalls: driftedCalls,
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents: [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS],
  });
  arms[1].providerRouteRatio = arms[1].modelCallInventory.providerRouteRatio;
  arms[1].tokenSourceProviderRatio = arms[1].modelCallInventory.tokenSourceProviderRatio;
  const driftGate = evaluate(arms).arms.treatment.gates.provider_and_token_source;
  assert.equal(driftGate.status, "FAIL");
  assert.deepEqual(driftGate.observed.unexpectedRouteCallIds, [sensor.id]);

  const missingAgent = passingEvidence();
  missingAgent[0].modelCallInventory = summarizeModelCallInventory({
    modelCalls: missingAgent[0].modelCallInventory.calls.filter((call) => call.agent !== "librarian"),
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents: [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS],
  });
  missingAgent[0].providerRouteRatio = missingAgent[0].modelCallInventory.providerRouteRatio;
  missingAgent[0].tokenSourceProviderRatio = missingAgent[0].modelCallInventory.tokenSourceProviderRatio;
  assert.equal(evaluate(missingAgent).arms.baseline.gates.provider_and_token_source.status, "FAIL");
  assert.deepEqual(missingAgent[0].modelCallInventory.missingAgents, ["librarian"]);

  const schemaFailure = summarizeModelCallInventory({
    modelCalls: driftedCalls.map((call) => call.agent === "builder" ? { ...call, schemaValid: 0 } : call),
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents: [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS],
  });
  assert.equal(schemaFailure.status, "FAIL");
  assert.deepEqual(schemaFailure.schemaFailureCallIds, [driftedCalls.find((call) => call.agent === "builder").id]);

  const missingMetadata = summarizeModelCallInventory({
    modelCalls: driftedCalls.map((call) => call.agent === "distiller" ? { ...call, tokenSource: null } : call),
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents: [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS],
  });
  assert.equal(missingMetadata.status, "FAIL");
  assert.deepEqual(missingMetadata.missingMetadataCallIds, [driftedCalls.find((call) => call.agent === "distiller").id]);
});

test("compressed analyzer classification requires the complete fresh invocation-bound canonical check set", () => {
  assert.deepEqual([...CANONICAL_COMPRESSED_ANALYZER_CHECK_NAMES], [...CANONICAL_ANALYZER_CHECK_NAMES]);
  const replicateId = "pair-001-baseline";
  const classification = completeAnalyzerClassification(replicateId);
  const expectation = {
    expectedInvocationNonce: `nonce-${replicateId}`,
    expectedReplicateId: replicateId,
    expectedSourceDigest: `sha256:${replicateId}`,
    startedAtMs: Date.parse("2026-07-10T08:00:00.000Z"),
    classificationMtimeMs: Date.parse("2026-07-10T08:00:02.000Z"),
  };
  assert.equal(validCompressedAnalyzerClassification(classification, expectation), true);

  const truncated = classifyCompressedAnalyzerChecks(
    CANONICAL_ANALYZER_CHECK_NAMES.slice(0, -1).map((name) => [name, { status: "PASS" }]),
    analyzerBinding(replicateId),
  );
  assert.equal(validCompressedAnalyzerClassification(truncated, expectation), false);

  const duplicatedRows = CANONICAL_ANALYZER_CHECK_NAMES.map((name) => [name, { status: "PASS" }]);
  duplicatedRows.splice(5, 0, [CANONICAL_ANALYZER_CHECK_NAMES[5], { status: "PASS" }]);
  assert.equal(validCompressedAnalyzerClassification(
    classifyCompressedAnalyzerChecks(duplicatedRows, analyzerBinding(replicateId)),
    expectation,
  ), false);

  const extra = classifyCompressedAnalyzerChecks(
    [...CANONICAL_ANALYZER_CHECK_NAMES.map((name) => [name, { status: "PASS" }]), ["unexpectedGate", { status: "PASS" }]],
    analyzerBinding(replicateId),
  );
  assert.equal(validCompressedAnalyzerClassification(extra, expectation), false);

  const unknownStatus = completeAnalyzerClassification(replicateId);
  unknownStatus.checkStatuses.runnerCrashedZero = "UNKNOWN";
  assert.equal(validCompressedAnalyzerClassification(unknownStatus, expectation), false);

  assert.equal(validCompressedAnalyzerClassification(classification, {
    ...expectation,
    expectedInvocationNonce: "nonce-from-another-invocation",
  }), false);
  assert.equal(validCompressedAnalyzerClassification(classification, {
    ...expectation,
    expectedReplicateId: "pair-999-treatment",
  }), false);
  assert.equal(validCompressedAnalyzerClassification(classification, {
    ...expectation,
    classificationMtimeMs: Date.parse("2026-07-10T07:59:59.000Z"),
  }), false);
  assert.equal(validCompressedAnalyzerClassification({
    ...classification,
    excludedChecks: [...classification.excludedChecks, "conflictAtLeast5"],
  }, expectation), false);
});

test("model call inventory uses the immutable complete agent set and rejects declaration downgrade", () => {
  const calls = REQUIRED_LEARNING_MODEL_CALLING_AGENTS.map((agent, index) => ({
    id: index + 1,
    cycleId: `cycle_${index + 1}`,
    agent,
    provider: "openai",
    model: "MiniMax-M3",
    tokenSource: "provider",
    schemaValid: 1,
    llmFailureType: null,
    inputTokenCount: 100,
    outputTokenCount: 20,
    tokenCount: 120,
    estimatedCost: 0.01,
  }));
  const inventory = (declaredRequiredAgents, modelCalls = calls) => summarizeModelCallInventory({
    modelCalls,
    expectedProvider: "openai",
    expectedModel: "MiniMax-M3",
    declaredRequiredAgents,
  });

  assert.equal(inventory([...REQUIRED_LEARNING_MODEL_CALLING_AGENTS]).status, "PASS");
  for (const declaration of [
    undefined,
    [],
    ["orchestrator"],
    REQUIRED_LEARNING_MODEL_CALLING_AGENTS.slice(0, -1),
    [...REQUIRED_LEARNING_MODEL_CALLING_AGENTS].reverse(),
    ["orchestrator", "sensor", "builder", "distiller", "library"],
  ]) {
    assert.equal(inventory(declaration).status, "FAIL", JSON.stringify(declaration));
  }

  const unexpected = inventory([...REQUIRED_LEARNING_MODEL_CALLING_AGENTS], [
    ...calls,
    { ...calls[0], id: 99, agent: "critic" },
  ]);
  assert.equal(unexpected.status, "FAIL");
  assert.deepEqual(unexpected.unexpectedAgents, ["critic"]);
});

test("governance audit requires train credit, rejects heldout credit, and checks Thompson/epsilon traces", () => {
  const events = [
    {
      eventType: "learning_case_resolved",
      caseId: "case_train",
      cycleId: "cycle_train",
      cycleIdx: 10,
      pool: "train",
      knowledgeInjection: { injectedKnowledgeIds: ["kb_1"], rankingMode: "thompson", epsilon: 0.1, injectionDisabled: false },
    },
    {
      eventType: "learning_case_resolved",
      caseId: "case_heldout",
      cycleId: "cycle_heldout",
      cycleIdx: 11,
      pool: "heldout",
      excludeFromCreditTraining: true,
      knowledgeInjection: { injectedKnowledgeIds: ["kb_1"], rankingMode: "thompson", epsilon: 0.1, injectionDisabled: false },
    },
  ];
  const credit = (cycleId) => ({
    actor: "knowledge_credit",
    tableName: "knowledge_items",
    op: "credit",
    cycleIdx: cycleId === "cycle_train" ? 10 : 11,
    before: JSON.stringify({ cycleId, knowledgeId: "kb_1", knowledge: { id: "kb_1", status: "active" } }),
    after: JSON.stringify({ cycleId, knowledgeId: "kb_1", knowledge: { id: "kb_1", status: "active" } }),
  });
  const knowledgeInsert = {
    actor: "distiller",
    tableName: "knowledge_items",
    op: "insert",
    cycleIdx: 1,
    before: null,
    after: JSON.stringify({ id: "kb_1", status: "active" }),
  };

  const clean = summarizeLearningGovernanceAudit({
    arm: "treatment",
    events,
    auditRows: [knowledgeInsert, credit("cycle_train")],
    knowledgeRows: [{ id: "kb_1", status: "active", superseded_by: null }],
  });
  assert.equal(clean.status, "PASS");
  assert.equal(clean.creditAuditComplete, true);

  const leaked = summarizeLearningGovernanceAudit({
    arm: "treatment",
    events,
    auditRows: [knowledgeInsert, credit("cycle_train"), credit("cycle_heldout")],
    knowledgeRows: [{ id: "kb_1", status: "active", superseded_by: null }],
  });
  assert.equal(leaked.status, "FAIL");
  assert.deepEqual(leaked.heldoutCreditKeys, ["cycle_heldout:kb_1"]);
});

test("governance audit accepts only human-approved Librarian strong promotion", () => {
  const promotion = (humanApprovedCount) => ({
    id: 20,
    ts: "2026-07-10T09:00:02.000Z",
    actor: "librarian",
    tableName: "knowledge_items",
    op: "update",
    cycleIdx: 12,
    before: JSON.stringify({ knowledge: { id: "kb_approved", status: "active", humanApprovedCount } }),
    after: JSON.stringify({ knowledge: { id: "kb_approved", status: "strong", humanApprovedCount } }),
  });

  const approved = summarizeLearningGovernanceAudit({ auditRows: [promotion(1)] });
  assert.equal(approved.humanStrongBypassCount, 0);

  const unapproved = summarizeLearningGovernanceAudit({ auditRows: [promotion(0)] });
  assert.equal(unapproved.humanStrongBypassCount, 1);
});

test("governance pollution uses durable event order for same-cycle as-of-injection state", () => {
  const active = {
    id: 100,
    ts: "2026-07-10T09:00:00.000Z",
    actor: "distiller",
    tableName: "knowledge_items",
    op: "insert",
    cycleIdx: 22,
    before: null,
    after: JSON.stringify({ id: "kb_ordered", status: "active", supersededBy: null }),
  };
  const polluted = {
    id: 101,
    ts: "2026-07-10T09:00:02.000Z",
    actor: "librarian",
    tableName: "knowledge_items",
    op: "update",
    cycleIdx: 22,
    before: JSON.stringify({ id: "kb_ordered", status: "active", supersededBy: null }),
    after: JSON.stringify({ id: "kb_ordered", status: "conflict", supersededBy: "kb_replacement" }),
  };
  const learningEvent = (ts, cycleId) => ({
    eventType: "learning_case_resolved",
    ts,
    caseId: `case_${cycleId}`,
    cycleId,
    cycleIdx: 22,
    pool: "train",
    knowledgeInjection: {
      injectedKnowledgeIds: ["kb_ordered"],
      rankingMode: "thompson",
      epsilon: 0.1,
      injectionDisabled: false,
    },
  });

  const beforeTransition = summarizeLearningGovernanceAudit({
    arm: "treatment",
    events: [learningEvent("2026-07-10T09:00:01.000Z", "cycle_before")],
    auditRows: [active, polluted],
    knowledgeRows: [{ id: "kb_ordered", status: "conflict", superseded_by: "kb_replacement" }],
  });
  assert.equal(beforeTransition.pollutedHighRiskInjectionCount, 0);

  const afterTransition = summarizeLearningGovernanceAudit({
    arm: "treatment",
    events: [learningEvent("2026-07-10T09:00:03.000Z", "cycle_after")],
    auditRows: [active, polluted],
    knowledgeRows: [{ id: "kb_ordered", status: "conflict", superseded_by: "kb_replacement" }],
  });
  assert.deepEqual(afterTransition.pollutedHighRiskInjectionIds, ["cycle_after:kb_ordered"]);

  const reversedInput = summarizeLearningGovernanceAudit({
    arm: "treatment",
    events: [learningEvent("2026-07-10T09:00:03.000Z", "cycle_after")],
    auditRows: [polluted, active],
    knowledgeRows: [{ id: "kb_ordered", status: "conflict", superseded_by: "kb_replacement" }],
  });
  assert.deepEqual(reversedInput.pollutedHighRiskInjectionIds, afterTransition.pollutedHighRiskInjectionIds);
});
