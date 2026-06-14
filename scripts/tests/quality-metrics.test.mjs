import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDecisionTsr,
  latencyAndEfficiencyMetrics,
  rssSlopeMbPerHour,
  scoreResolutionAccuracy,
} from "../lib/health-signal-quality.mjs";

test("decisionTsr fails when an unsuperseded ppg_only card remains active", () => {
  const result = evaluateDecisionTsr([
    {
      id: "kb_gate_sample_0001_ppg_support",
      title: "PPG 优先证据：成本与续航匹配",
      content: "当前最优选型决策：优先 PPG，置信度 0.64。",
      status: "active",
      supersededBy: null,
    },
    {
      id: "kb_gate_sample_0005_hybrid_support",
      title: "混合方案证据：PPG 连续 + ECG 复核",
      content: "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
      status: "active",
      supersededBy: null,
    },
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.passed, false);
  assert.equal(result.hybridLayeredCount, 1);
  assert.equal(result.disallowedFinalCount, 1);
  assert.equal(result.disallowedFinalKnowledge[0].decision, "ppg_only");
  assert.match(result.interpretation, /pass@1/);
});

test("resolutionAccuracy deducts when the weaker side is preserved", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_bad_ppg",
      primaryKnowledgeId: "kb_sample_0003_ppg_risk",
      relatedKnowledgeId: "kb_sample_0001_ppg_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0001_ppg_support",
    },
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.blockingEligible, true);
  assert.equal(result.scored, 1);
  assert.equal(result.unscored, 0);
  assert.equal(result.correct, 0);
  assert.equal(result.accuracy, 0);
});

test("resolutionAccuracy reports low scoreable coverage instead of a misleading pass", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_good",
      primaryKnowledgeId: "kb_sample_0001_ppg_support",
      relatedKnowledgeId: "kb_sample_0003_ppg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0003_ppg_risk",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_unknown_1",
      primaryKnowledgeId: "kb_generic_a",
      relatedKnowledgeId: "kb_generic_b",
      action: "quarantine",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_unknown_2",
      primaryKnowledgeId: "kb_generic_c",
      relatedKnowledgeId: "kb_generic_d",
      action: "quarantine",
    },
  ]);

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.accuracy, 1);
  assert.equal(result.scored, 1);
  assert.equal(result.unscored, 2);
  assert.equal(result.scoreableCoverage, 0.333333);
});

test("resolutionAccuracy infers oracle side from legacy knowledge ids", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_legacy",
      primaryKnowledgeId: "kb_gate_sample_0001_ppg_support",
      relatedKnowledgeId: "kb_gate_sample_0003_ppg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_gate_sample_0003_ppg_risk",
    },
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.scored, 1);
  assert.equal(result.correct, 1);
});

test("latency and efficiency ratios stay null when denominators are zero", () => {
  const result = latencyAndEfficiencyMetrics({
    events: [
      { eventType: "api_request_timing", segment: "harness_polling_api_request", durationMs: 10 },
      { eventType: "api_request_timing", segment: "harness_polling_api_request", durationMs: 30 },
      { eventType: "api_request_timing", segment: "scheduler_tick", durationMs: 50 },
    ],
    samples: [
      { cyclesClosed: 0, resolvedConflictReviews: 0, activeCount: 5, llmEstimatedCostUsd: 1.25 },
      { cyclesClosed: 0, resolvedConflictReviews: 0, activeCount: 5, llmEstimatedCostUsd: 1.25 },
    ],
    llmCalls: [
      { agent: "sensor", latencyMs: 100, tokenCount: 500, estimatedCost: 0.2 },
    ],
  });

  assert.equal(result.apiRequest.p95Ms, 50);
  assert.equal(result.apiRequestBySegment.harness_polling_api_request.p95Ms, 30);
  assert.equal(result.ratios.costPerClosedCycleUsd, null);
  assert.equal(result.ratios.tokensPerResolvedConflict, null);
  assert.equal(result.ratios.costPerNetActiveKnowledgeUsd, null);
  assert.match(result.measurementNote, /harness/);
});

test("rssSlopeMbPerHour computes linear memory slope", () => {
  const slope = rssSlopeMbPerHour([
    { epoch: 1000, appRssMb: 100 },
    { epoch: 1000 + 3600, appRssMb: 125 },
    { epoch: 1000 + 7200, appRssMb: 150 },
  ]);

  assert.equal(slope, 25);
});
