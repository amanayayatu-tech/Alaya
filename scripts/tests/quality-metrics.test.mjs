import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFLICT_QUALITY_MIN_ELIGIBLE,
  evaluateConfidenceCalibration,
  evaluateDecisionTsr,
  evaluateFaithfulness,
  latencyAndEfficiencyMetrics,
  rssSlopeMbPerHour,
  scoreResolutionAccuracy,
} from "../lib/health-signal-quality.mjs";
import { buildCognitionCoverageEvidence } from "../lib/cognition-coverage-scenario.mjs";

function tieredSupportKnowledge(index, overrides = {}) {
  const sampleId = String(index + 1).padStart(4, "0");
  return {
    id: `kb_proj_runtime_${String(index).padStart(3, "0")}`,
    sourceRef: `equity-thesis-contradiction-runner:sample_${sampleId}_tiered_support`,
    content: [
      "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
      "tiered_thesis_confidence >= 0.81。",
      "明确冲突：该结论与分层仓位反证互相矛盾，不能同时作为 active 知识复用。",
      "当前最优仓位决策：多空分层仓位方案，置信度 1.0。",
    ].join("\n"),
    status: "active",
    confidence_score: 1,
    ...overrides,
  };
}

function approvedCognitionCoverageKnowledge(ordinal) {
  const sample = buildCognitionCoverageEvidence(ordinal);
  return {
    id: `kb_gate_phase2_${sample.externalId}`,
    title: `外部反馈: ${sample.title}`,
    content: [
      `Human approved meaning gate gate_phase2_${sample.externalId}.`,
      `Source: form_feedback ${sample.externalId}.`,
      `Summary: ${sample.title}.`,
      `User quote: Form Feedback (${sample.sourceName} ${sample.externalId}): ${sample.title}\n\n${sample.text}.`,
    ].join("\n"),
    sourceRef: sample.externalId,
    status: "active",
    confidence_score: 0.99,
    tags: ["meaning_gate", "human_approved", sample.sourceName, "phase2_cognition_coverage"],
  };
}

function cognitionCoverageEvent(ordinal) {
  const sample = buildCognitionCoverageEvidence(ordinal);
  return {
    eventType: "contradiction_feedback_injected",
    sample: ordinal,
    scenario: "cognition-coverage",
    coverageOrdinal: ordinal,
    side: sample.side,
    externalId: sample.externalId,
    evidenceTitle: sample.title,
    evidenceText: sample.text,
  };
}

test("cognition coverage samples are scoreable without conflict-marker metric changes", () => {
  const count = 30;
  const knowledge = Array.from({ length: count }, (_, index) => approvedCognitionCoverageKnowledge(index + 1));
  const events = Array.from({ length: count }, (_, index) => cognitionCoverageEvent(index + 1));

  for (const event of events) {
    assert.match(event.externalId, /^sample_\d{4}_tiered_support$/);
    assert.doesNotMatch(event.evidenceText, /明确冲突|互相矛盾/);
  }

  const calibration = evaluateConfidenceCalibration(knowledge);
  assert.equal(calibration.blockingEligible, true);
  assert.equal(calibration.eligible, count);
  assert.equal(calibration.scored, count);
  assert.equal(calibration.scoreableCoverage, 1);

  const faithfulness = evaluateFaithfulness({ knowledgeItems: knowledge, events });
  assert.equal(faithfulness.blockingEligible, true);
  assert.equal(faithfulness.eligible, count);
  assert.equal(faithfulness.scoreableKnowledgeItems, count);
  assert.equal(faithfulness.scoreableCoverage, 1);
  assert.equal(faithfulness.faithfulness, 1);
});

test("decisionTsr fails when an unsuperseded long_only card remains active", () => {
  const result = evaluateDecisionTsr([
    {
      id: "kb_gate_sample_0001_long_support",
      title: "看多优先证据：基本面上修与估值修复",
      content: "当前最优仓位决策：优先做多，置信度 0.64。",
      status: "active",
      supersededBy: null,
    },
    {
      id: "kb_gate_sample_0005_tiered_support",
      title: "分层仓位证据：核心多头 + 空头对冲",
      content: "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
      status: "active",
      supersededBy: null,
    },
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.passed, false);
  assert.equal(result.tieredThesisCount, 1);
  assert.equal(result.disallowedFinalCount, 1);
  assert.equal(result.disallowedFinalKnowledge[0].decision, "long_only");
  assert.match(result.interpretation, /pass@1/);
});

test("decisionTsr includes implemented passK when aggregate data is supplied", () => {
  const result = evaluateDecisionTsr([
    {
      id: "kb_gate_sample_0005_tiered_support",
      content: "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
      status: "active",
    },
  ], {
    passKAggregate: {
      k: 3,
      passAt1: 1,
      passPowK: 1,
      status: "pass",
      thresholds: { passAt1: 0.85, passPowK: 0.6 },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.passK.implemented, true);
  assert.equal(result.passK.k, 3);
  assert.equal(result.passK.passAt1, 1);
  assert.equal(result.passK.passPowK, 1);
});

test("resolutionAccuracy deducts when the weaker side is preserved", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_bad_long",
      primaryKnowledgeId: "kb_sample_0003_long_risk",
      relatedKnowledgeId: "kb_sample_0001_long_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0001_long_support",
    },
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.blockingEligible, true);
  assert.equal(result.scored, 1);
  assert.equal(result.unscored, 0);
  assert.equal(result.correct, 0);
  assert.equal(result.accuracy, 0);
});

test("resolutionAccuracy deducts wrong winners for every expanded tier rule", () => {
  const cases = [
    {
      name: "T1 beats T2",
      primaryKnowledgeId: "kb_sample_tiered_support",
      relatedKnowledgeId: "kb_sample_long_risk",
      survivorKnowledgeId: "kb_sample_long_risk",
      expectedRule: "tiered_support_beats_long_risk",
    },
    {
      name: "T1 beats T3",
      primaryKnowledgeId: "kb_sample_tiered_support",
      relatedKnowledgeId: "kb_sample_short_support",
      survivorKnowledgeId: "kb_sample_short_support",
      expectedRule: "tiered_support_beats_short_support",
    },
    {
      name: "T1 beats T4",
      primaryKnowledgeId: "kb_sample_tiered_support",
      relatedKnowledgeId: "kb_sample_tiered_reject",
      survivorKnowledgeId: "kb_sample_tiered_reject",
      expectedRule: "tiered_support_beats_tiered_reject",
    },
    {
      name: "T2 beats cross-family T3",
      primaryKnowledgeId: "kb_sample_short_risk",
      relatedKnowledgeId: "kb_sample_long_support",
      survivorKnowledgeId: "kb_sample_long_support",
      expectedRule: "short_risk_beats_long_support",
    },
    {
      name: "T2 beats T4",
      primaryKnowledgeId: "kb_sample_long_risk",
      relatedKnowledgeId: "kb_sample_tiered_reject",
      survivorKnowledgeId: "kb_sample_tiered_reject",
      expectedRule: "long_risk_beats_tiered_reject",
    },
  ];

  for (const item of cases) {
    const result = scoreResolutionAccuracy([
      {
        eventType: "knowledge_review_resolved",
        reviewId: `kr_bad_${item.name.replace(/\W+/g, "_")}`,
        primaryKnowledgeId: item.primaryKnowledgeId,
        relatedKnowledgeId: item.relatedKnowledgeId,
        action: "merge_supersede",
        survivorKnowledgeId: item.survivorKnowledgeId,
      },
    ]);

    assert.equal(result.status, "fail", item.name);
    assert.equal(result.scored, 1, item.name);
    assert.equal(result.correct, 0, item.name);
    assert.equal(result.scoredEvents[0].scoreableResolutionRule, item.expectedRule, item.name);
    assert.match(result.scoredEvents[0].scoreableResolutionRationale, /T[12]/, item.name);
  }
});

test("resolutionAccuracy scores same-side duplicates as merge-only dedupe", () => {
  const good = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_dedupe_good",
      primaryKnowledgeId: "kb_sample_0001_short_risk",
      relatedKnowledgeId: "kb_sample_0007_short_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0007_short_risk",
    },
  ]);
  assert.equal(good.status, "pass");
  assert.equal(good.scored, 1);
  assert.equal(good.correct, 1);
  assert.equal(good.scoredEvents[0].resolutionDuplicatePair, true);
  assert.equal(good.duplicatePairTypeCounts["short_risk|short_risk"], 1);

  const bad = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_dedupe_bad",
      primaryKnowledgeId: "kb_sample_0001_short_risk",
      relatedKnowledgeId: "kb_sample_0007_short_risk",
      action: "quarantine",
    },
  ]);
  assert.equal(bad.status, "fail");
  assert.equal(bad.scored, 1);
  assert.equal(bad.correct, 0);
  assert.equal(bad.scoredEvents[0].resolutionExpectedAction, "merge_supersede");

  const embeddingMode = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_dedupe_embedding",
      primaryKnowledgeId: "kb_sample_0001_short_risk",
      relatedKnowledgeId: "kb_sample_0007_short_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0007_short_risk",
    },
  ], { dedupeMode: "embedding" });
  assert.equal(embeddingMode.status, "pass");
  assert.equal(embeddingMode.dedupeMode, "embedding");
  assert.equal(embeddingMode.scoredEvents[0].dedupeMode, "embedding");
  assert.match(embeddingMode.scoredEvents[0].scoreableResolutionRule, /embedding_fallback/);
});

test("resolutionAccuracy reports low scoreable coverage instead of a misleading pass", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_good",
      primaryKnowledgeId: "kb_sample_0001_long_support",
      relatedKnowledgeId: "kb_sample_0003_long_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0003_long_risk",
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
  assert.equal(result.unscoredPairTypeCounts["unknown|unknown"], 2);
  assert.equal(result.unscoredReasonCounts.unknown_oracle_side, 2);
});

test("resolutionAccuracy keeps deliberately ambiguous pairs unscored", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t2_t2",
      primaryKnowledgeId: "kb_sample_long_risk",
      relatedKnowledgeId: "kb_sample_short_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_short_risk",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t3_t3",
      primaryKnowledgeId: "kb_sample_long_support",
      relatedKnowledgeId: "kb_sample_short_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_short_support",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t3_t4",
      primaryKnowledgeId: "kb_sample_long_support",
      relatedKnowledgeId: "kb_sample_tiered_reject",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_tiered_reject",
    },
  ]);

  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 0);
  assert.equal(result.unscored, 3);
  assert.equal(result.unscoredReasonCounts.ambiguous_same_layer_t2_risk_pair, 1);
  assert.equal(result.unscoredReasonCounts.ambiguous_same_layer_t3_support_pair, 1);
  assert.equal(result.unscoredReasonCounts.ambiguous_t3_support_vs_t4_tiered_reject, 1);
});

test("resolutionAccuracy infers oracle side from legacy knowledge ids", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_legacy",
      primaryKnowledgeId: "kb_gate_sample_0001_long_support",
      relatedKnowledgeId: "kb_gate_sample_0003_long_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_gate_sample_0003_long_risk",
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

test("latency SLO excludes harness polling and only blocks when enforced", () => {
  const passResult = latencyAndEfficiencyMetrics({
    events: [
      { eventType: "api_request_timing", segment: "harness_polling_api_request", durationMs: 120000 },
      { eventType: "api_request_timing", segment: "knowledge_retrieval", durationMs: 1500 },
      { eventType: "api_request_timing", segment: "scheduler_tick", durationMs: 2000 },
    ],
  });

  assert.equal(passResult.slo.sloStatus, "pass");
  assert.equal(passResult.slo.sloBlocking, false);
  assert.deepEqual(passResult.slo.excludedSegments, ["harness_polling_api_request"]);
  assert.match(passResult.slo.measurementNote, /harness_polling_api_request is excluded/);

  const failResult = latencyAndEfficiencyMetrics({
    enforceLatencySlo: true,
    events: [
      { eventType: "api_request_timing", segment: "knowledge_retrieval", durationMs: 3000 },
      { eventType: "api_request_timing", segment: "scheduler_tick", durationMs: 2000 },
    ],
  });

  assert.equal(failResult.slo.sloStatus, "fail");
  assert.equal(failResult.slo.sloBlocking, true);
});

test("confidenceCalibration computes ECE from scored oracle knowledge", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_sample_0005_tiered_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0005_tiered_support",
      title: "分层仓位证据：核心多头 + 空头对冲",
      content: [
        "分层仓位证据：核心多头 + 空头对冲。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案，置信度 0.8。",
      ].join("\n"),
      status: "active",
      supersededBy: null,
      confidence_score: 0.8,
    },
    {
      id: "kb_sample_0001_long_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0001_long_support",
      title: "看多优先证据",
      content: [
        "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振。",
        "long_thesis_score >= 0.78。",
        "明确冲突：该结论与 看空优先互相矛盾。",
        "当前最优仓位决策：优先做多，置信度 0.6。",
      ].join("\n"),
      status: "active",
      supersededBy: "",
      confidence_score: 0.6,
    },
  ], { bucketCount: 2 });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.scored, 2);
  assert.equal(result.unscored, 0);
  assert.equal(result.totalCandidates, 2);
  assert.equal(result.eligible, 2);
  assert.equal(result.denominator, 2);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.ece, 0.2);
  assert.deepEqual(result.reliabilityTable.map((row) => ({
    bucket: row.bucket,
    confMean: row.confMean,
    accuracy: row.accuracy,
    n: row.n,
  })), [
    { bucket: 1, confMean: 0.7, accuracy: 0.5, n: 2 },
  ]);
});

test("confidenceCalibration reports low coverage without blocking", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_sample_0005_tiered_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0005_tiered_support",
      content: [
        "分层仓位证据：核心多头 + 空头对冲。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案，置信度 1.0。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_generic_unknown",
      content: "没有 oracle side 的普通知识，置信度 0.7。",
      status: "active",
    },
    {
      id: "kb_proj_long_risk_missing_confidence",
      content: [
        "看多反证来自估值分位过高、盈利兑现滞后和多头拥挤。",
        "long_thesis_score <= 0.42。",
        "明确冲突：该证据削弱之前 看多优先结论。",
      ].join("\n"),
      status: "active",
    },
  ]);

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 1);
  assert.equal(result.unscored, 1);
  assert.equal(result.totalCandidates, 3);
  assert.equal(result.eligible, 2);
  assert.equal(result.denominator, 2);
  assert.equal(result.scoreableDenominator, 2);
  assert.equal(result.scoreableCoverage, 0.5);
  assert.equal(result.ece, 0);
  assert.equal(result.unscoredReasonCounts.missing_confidence, 1);
  assert.equal(result.excludedAsNonConflict.count, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.no_oracle_side, 1);
});

test("confidenceCalibration returns null ECE when oracle samples lack confidence", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_proj_short_risk_missing_confidence",
      content: [
        "看空反证来自空头拥挤和回补风险。",
        "long_thesis_score >= 0.72。",
        "明确冲突：该证据反驳 看空优先。",
      ].join("\n"),
      status: "active",
    },
  ]);

  assert.equal(result.status, "low_coverage");
  assert.equal(result.ece, null);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.totalCandidates, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.denominator, 1);
  assert.equal(result.scoreableDenominator, 1);
  assert.equal(result.scoreableCoverage, 0);
  assert.equal(result.blockingEligible, false);
  assert.deepEqual(result.reliabilityTable, []);
  assert.equal(result.unscoredReasonCounts.missing_confidence, 1);
});

test("confidenceCalibration excludes no-oracle knowledge before ECE scoring", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_generic_unknown",
      content: "没有 oracle side 的普通知识，置信度 0.7。",
      status: "active",
    },
  ]);

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 0);
  assert.equal(result.unscored, 0);
  assert.equal(result.totalCandidates, 1);
  assert.equal(result.eligible, 0);
  assert.equal(result.denominator, 0);
  assert.equal(result.scoreableDenominator, 0);
  assert.equal(result.scoreableCoverage, 0);
  assert.equal(result.outOfScopeNoOracle, 1);
  assert.deepEqual(result.unscoredReasonCounts, {});
  assert.equal(result.excludedAsNonConflict.count, 1);
  assert.deepEqual(result.excludedAsNonConflict.exampleIds, ["kb_generic_unknown"]);
  assert.equal(result.excludedAsNonConflict.reasonCounts.no_oracle_side, 1);
});

test("confidenceCalibration excludes governance restatements and keeps kb_proj conflict evidence", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_seed_identity_001",
      content: "目标标的流动性合格，单票仓位上限 12%，组合最大回撤预算 8%，置信度 0.95。",
      status: "active",
    },
    {
      id: "kb_proj_market_context",
      title: "种子身份",
      content: "当前最优仓位决策：多空分层仓位方案。须遵守仓位上限和回撤预算，遇看多/看空矛盾必须等待人工审核，budget_throttle_effectiveness >= 0.85，置信度 0.88。",
      status: "active",
      tags: ["identity", "seed"],
      supersededBy: "kb_seed_identity_001",
    },
    {
      id: "kb_proj_conflict_tiered",
      content: [
        "分层仓位证据：核心多头 + 空头对冲。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
      ].join("\n"),
      status: "active",
      confidence_score: 0.71,
    },
    {
      id: "kb_sample_0002_short_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0002_short_support",
      content: [
        "看空优先：收入指引下修更有解释力。",
        "long_thesis_score <= 0.35。",
        "明确冲突：该结论与 看多优先互相矛盾。",
        "当前最优仓位决策：优先做空，置信度 0.66。",
      ].join("\n"),
      status: "active",
      confidence_score: 0.66,
    },
  ], { bucketCount: 2 });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 2);
  assert.equal(result.unscored, 0);
  assert.equal(result.totalCandidates, 4);
  assert.equal(result.eligible, 2);
  assert.equal(result.denominator, 2);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.excludedAsNonConflict.count, 2);
  assert.deepEqual(result.excludedAsNonConflict.exampleIds, ["kb_seed_identity_001", "kb_proj_market_context"]);
  assert.equal(result.excludedAsNonConflict.reasonCounts.seed_identity_or_world, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.governance_or_task_restatement, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.no_oracle_side ?? 0, 0);
  assert.equal(result.scoredKnowledge.some((item) => item.knowledgeId === "kb_proj_market_context"), false);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_proj_conflict_tiered").correct, true);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_sample_0002_short_support").correct, false);
});

test("confidenceCalibration excludes sensor firewall audit wrappers from oracle calibration", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_gate_gate_sensor_recurring_1234",
      sourceRef: "equity-thesis-contradiction-runner:sample_0029_tiered_support",
      title: "外部反馈: recurring market signal unknown from equity-thesis-contradiction-runner",
      content: "Human approved meaning gate gate_sensor_recurring_1234.",
      status: "strong",
      confidence_score: 0.98,
      tags: ["meaning_gate", "sensor_firewall", "external_feedback"],
    },
    {
      id: "kb_gate_sample_0004_short_risk",
      sourceRef: "equity-thesis-contradiction-runner:sample_0004_short_risk",
      content: [
        "看空反证：空头拥挤、回补风险和潜在上行催化会抬高单边做空的损失概率。",
        "long_thesis_score >= 0.72。",
        "明确冲突：该证据反驳 看空优先，必须隔离到冲突审查流程。",
      ].join("\n"),
      status: "strong",
      confidence_score: 0.9,
    },
  ]);

  assert.equal(result.scored, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.denominator, 1);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.excludedAsNonConflict.count, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.sensor_firewall_audit_wrapper, 1);
  assert.equal(result.scoredKnowledge[0].knowledgeId, "kb_gate_sample_0004_short_risk");
});

test("confidenceCalibration parses decision brief and template fallback confidence without changing correctness", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_sample_0005_tiered_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0005_tiered_support",
      content: [
        "分层仓位方案仍是最终决策。",
        "tiered_thesis_confidence >= 0.81。",
        "明确冲突：该结论与分层仓位反证互相矛盾。",
        "当前最优仓位决策：多空分层仓位方案。",
      ].join("\n"),
      status: "active",
      decision_brief: {
        claim: "分层仓位方案仍是最终决策",
        confidence: 0.72,
      },
    },
    {
      id: "kb_gate_sample_0001_long_support",
      sourceRef: "equity-thesis-contradiction-runner:sample_0001_long_support",
      content: [
        "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振。",
        "long_thesis_score >= 0.78。",
        "明确冲突：该结论与 看空优先互相矛盾。",
        "当前最优仓位决策：优先做多。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_proj_short_risk_missing_confidence",
      content: [
        "看空反证存在，但缺少置信度。",
        "long_thesis_score >= 0.72。",
        "明确冲突：该证据反驳 看空优先。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_proj_tiered_reject_missing_confidence",
      content: [
        "分层仓位反证存在，但缺少置信度。",
        "tiered_thesis_confidence <= 0.38。",
        "明确冲突：该结论与分层仓位方案推荐互相矛盾。",
      ].join("\n"),
      status: "active",
    },
  ], { bucketCount: 2 });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 2);
  assert.equal(result.unscored, 2);
  assert.equal(result.eligible, 4);
  assert.equal(result.denominator, 4);
  assert.equal(result.scoreableCoverage, 0.5);
  assert.equal(result.unscoredReasonCounts.missing_confidence, 2);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_sample_0005_tiered_support").confidence, 0.72);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_gate_sample_0001_long_support").confidence, 0.64);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_gate_sample_0001_long_support").correct, false);
});

test("confidenceCalibration only blocks when eligible coverage and sample count are sufficient", () => {
  const passResult = evaluateConfidenceCalibration(
    Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => tieredSupportKnowledge(index)),
  );

  assert.equal(passResult.status, "pass");
  assert.equal(passResult.blockingEligible, true);
  assert.equal(passResult.totalCandidates, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.eligible, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.denominator, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.scored, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.scoreableCoverage, 1);

  const failResult = evaluateConfidenceCalibration(
    Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => ({
      id: `kb_proj_wrong_long_${String(index).padStart(3, "0")}`,
      content: [
        "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振。",
        "long_thesis_score >= 0.78。",
        "明确冲突：该结论与 看空优先互相矛盾。",
        "当前最优仓位决策：优先做多，置信度 1.0。",
      ].join("\n"),
      status: "active",
      confidence_score: 1,
    })),
  );

  assert.equal(failResult.status, "fail");
  assert.equal(failResult.blockingEligible, true);
  assert.equal(failResult.scored, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(failResult.scoreableCoverage, 1);
  assert.equal(failResult.ece, 1);

  const lowCoverage = evaluateConfidenceCalibration(
    Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => (
      index < 5
        ? tieredSupportKnowledge(index)
        : tieredSupportKnowledge(index, {
          sourceRef: "",
          confidence_score: undefined,
          content: [
            "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
            "tiered_thesis_confidence >= 0.81。",
            "明确冲突：该结论与分层仓位反证互相矛盾，不能同时作为 active 知识复用。",
            "当前最优仓位决策：多空分层仓位方案。",
          ].join("\n"),
        })
    )),
  );

  assert.equal(lowCoverage.status, "low_coverage");
  assert.equal(lowCoverage.blockingEligible, false);
  assert.equal(lowCoverage.eligible, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(lowCoverage.denominator, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(lowCoverage.scored, 5);
  assert.equal(lowCoverage.unscored, 5);
  assert.equal(lowCoverage.scoreableCoverage, 0.5);
});

test("faithfulness passes when active claims are supported by evidence corpus", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      [
        "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
        "tiered_thesis_confidence >= 0.81。",
        "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
      ].join("\n"),
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0005_tiered_support",
        sourceRef: "equity-thesis-contradiction-runner:sample_0005_tiered_support",
        status: "active",
        content: [
          "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
          "tiered_thesis_confidence >= 0.81。",
          "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.judgeMode, "lexical");
  assert.equal(result.faithfulness, 1);
  assert.equal(result.hallucinationRate, 0);
  assert.equal(result.unsupportedClaims.length, 0);
  assert.equal(result.scored, 3);
  assert.equal(result.scoreableKnowledgeItems, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.denominator, 1);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.blockingEligible, false);
});

test("faithfulness flags unsupported injected-looking claims", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振，基本面上行更支持多头仓位。",
      "long_thesis_score >= 0.78。",
      "明确冲突：该结论与 看空优先互相矛盾。",
      "当前最优仓位决策：优先做多，置信度 0.64。",
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0001_long_support",
        sourceRef: "equity-thesis-contradiction-runner:sample_0001_long_support",
        status: "active",
        content: [
          "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振，基本面上行更支持多头仓位。",
          "long_thesis_score >= 0.78。",
          "明确冲突：该结论与 看空优先互相矛盾。",
          "当前最优仓位决策：优先做多，置信度 0.64。",
          "新增主张：已经完成 监管披露合规审查，置信度 0.92。",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.supported, 4);
  assert.equal(result.unsupported, 1);
  assert.equal(result.hallucinationRate, 0.2);
  assert.match(result.unsupportedClaims[0].claim, /监管披露合规审查/);
});

test("faithfulness scores Chinese domain phrases without numeric anchors and still catches unsupported claims", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "看多反证：估值分位过高、盈利兑现滞后和多头拥挤会削弱单边看多结论，long_thesis_score <= 0.42。",
      "建议：保留核心多头观察仓位，但需要空头或现金对冲控制回撤。",
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0003_long_risk",
        sourceRef: "equity-thesis-contradiction-runner:sample_0003_long_risk",
        status: "active",
        content: [
          "看多反证来自估值分位过高、盈利兑现滞后和多头拥挤，long_thesis_score <= 0.42。",
          "新增主张：看多反证已经完成 监管披露合规审查。",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 2);
  assert.equal(result.supported, 1);
  assert.equal(result.unsupported, 1);
  assert.equal(result.scoreableCoverage, 1);
  assert.match(result.unsupportedClaims[0].claim, /监管披露合规审查/);
  assert.ok(result.unsupportedClaims[0].anchors.some((anchor) => /监管披露合规审查/.test(anchor)));
});

test("faithfulness only blocks when eligible knowledge coverage and sample count are sufficient", () => {
  const evidenceCorpus = [
    "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动、估值回撤和事件风险保护。",
    "tiered_thesis_confidence >= 0.81。",
    "明确冲突：该结论与分层仓位反证互相矛盾，不能同时作为 active 知识复用。",
    "当前最优仓位决策：多空分层仓位方案，置信度 1.0。",
    "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振，基本面上行更支持多头仓位。",
    "long_thesis_score >= 0.78。",
    "明确冲突：该结论与 看空优先互相矛盾。",
    "当前最优仓位决策：优先做多，置信度 0.64。",
  ];
  const passResult = evaluateFaithfulness({
    evidenceCorpus,
    knowledgeItems: Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => tieredSupportKnowledge(index)),
  });

  assert.equal(passResult.status, "pass");
  assert.equal(passResult.blockingEligible, true);
  assert.equal(passResult.eligible, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.denominator, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.scoreableKnowledgeItems, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(passResult.scoreableCoverage, 1);
  assert.equal(passResult.faithfulness, 1);

  const failResult = evaluateFaithfulness({
    evidenceCorpus,
    knowledgeItems: Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => ({
      id: `kb_proj_long_support_${String(index).padStart(3, "0")}`,
      status: "active",
      content: [
        "看多优先：目标公司收入增速、毛利率改善和自由现金流修复共振，基本面上行更支持多头仓位。",
        "long_thesis_score >= 0.78。",
        "明确冲突：该结论与 看空优先互相矛盾。",
        "当前最优仓位决策：优先做多，置信度 0.64。",
        "新增主张：已经完成 监管披露合规审查，置信度 0.92。",
      ].join("\n"),
    })),
  });

  assert.equal(failResult.status, "fail");
  assert.equal(failResult.blockingEligible, true);
  assert.equal(failResult.eligible, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(failResult.scoreableKnowledgeItems, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(failResult.scoreableCoverage, 1);
  assert.equal(failResult.faithfulness, 0.8);
  assert.equal(failResult.unsupported, CONFLICT_QUALITY_MIN_ELIGIBLE);

  const lowCoverage = evaluateFaithfulness({
    evidenceCorpus,
    knowledgeItems: Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => (
      index < 5
        ? tieredSupportKnowledge(index)
        : {
          id: `kb_proj_sparse_tiered_support_${String(index).padStart(3, "0")}`,
          sourceRef: `equity-thesis-contradiction-runner:sample_${String(index + 1).padStart(4, "0")}_tiered_support`,
          status: "active",
          tags: ["tiered_thesis_confidence>=0.81"],
          content: "流程备注等待后续复查。",
        }
    )),
  });

  assert.equal(lowCoverage.status, "low_coverage");
  assert.equal(lowCoverage.blockingEligible, false);
  assert.equal(lowCoverage.eligible, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(lowCoverage.denominator, CONFLICT_QUALITY_MIN_ELIGIBLE);
  assert.equal(lowCoverage.scoreableKnowledgeItems, 5);
  assert.equal(lowCoverage.scoreableCoverage, 0.5);
  assert.equal(lowCoverage.indeterminateReasonCounts.no_deterministic_anchor, 5);
});

test("faithfulness excludes governance restatements and keeps true conflict evidence", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "看多反证：估值分位过高、盈利兑现滞后和多头拥挤会削弱单边看多结论，long_thesis_score <= 0.42。",
      "当前最优仓位决策：多空分层仓位方案。须遵守仓位上限和回撤预算，遇看多/看空矛盾必须等待人工审核。",
    ],
    knowledgeItems: [
      {
        id: "kb_seed_world_001",
        status: "active",
        content: "目标标的流动性合格，单票仓位上限 12%，必须控制组合回撤。",
      },
      {
        id: "kb_proj_regulatory_context",
        title: "种子世界",
        status: "active",
        tags: ["world", "seed"],
        supersededBy: "kb_seed_world_001",
        content: "当前最优仓位决策：多空分层仓位方案。须遵守仓位上限和回撤预算，遇看多/看空矛盾必须等待人工审核，risk_gate_recovery_proof_coverage >= 0.85。",
      },
      {
        id: "kb_sample_0003_long_risk",
        sourceRef: "equity-thesis-contradiction-runner:sample_0003_long_risk",
        status: "active",
        content: "看多反证来自估值分位过高、盈利兑现滞后和多头拥挤，long_thesis_score <= 0.42。",
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 1);
  assert.equal(result.supported, 1);
  assert.equal(result.unsupported, 0);
  assert.equal(result.indeterminate, 0);
  assert.equal(result.totalClaims, 1);
  assert.equal(result.scoreableKnowledgeItems, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.denominator, 1);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.excludedAsNonConflict.count, 2);
  assert.deepEqual(result.excludedAsNonConflict.exampleIds, ["kb_seed_world_001", "kb_proj_regulatory_context"]);
  assert.equal(result.excludedAsNonConflict.reasonCounts.seed_identity_or_world, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.governance_or_task_restatement, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.no_oracle_side ?? 0, 0);
});

test("faithfulness strips approval audit wrappers before scoring business claims", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "看空反证：回补风险与上行催化。",
      "看空反证：空头拥挤、回补风险和潜在上行催化会抬高单边做空的损失概率。",
      "long_thesis_score >= 0.72。",
      "明确冲突：该证据反驳 看空优先，必须隔离到冲突审查流程。",
    ],
    knowledgeItems: [
      {
        id: "kb_gate_sample_0004_short_risk",
        sourceRef: "equity-thesis-contradiction-runner:sample_0004_short_risk",
        title: "外部反馈: 看空反证：回补风险与上行催化",
        status: "strong",
        content: [
          "Human approved meaning gate gate_ext_fb_form_sample_0004_short_risk.",
          "Source: form_feedback sample_0004_short_risk.",
          "Summary: 看空反证：回补风险与上行催化.",
          "User quote: Form Feedback (equity-thesis-contradiction-runner sample_0004_short_risk): 看空反证：空头拥挤、回补风险和潜在上行催化会抬高单边做空的损失概率。\nlong_thesis_score >= 0.72。\n明确冲突：该证据反驳 看空优先，必须隔离到冲突审查流程。",
        ].join("\n"),
        notes: "approved via web\nReview kr_1234: survivor retained after absorbing duplicate.\nLibrarian merge: not physically deleted.",
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.unsupported, 0);
  assert.equal(result.indeterminate, 0);
  assert.equal(result.scoreableCoverage, 1);
  assert.equal(result.unsupportedClaims.length, 0);
});

test("faithfulness excludes sensor firewall audit wrappers from claim scoring", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "分层仓位证据：核心多头 + 空头对冲。",
    ],
    knowledgeItems: [
      {
        id: "kb_gate_gate_sensor_recurring_1234",
        sourceRef: "equity-thesis-contradiction-runner:sample_0029_tiered_support",
        title: "外部反馈: recurring market signal unknown from equity-thesis-contradiction-runner",
        status: "strong",
        content: "User quote: recurring market signal unknown from equity-thesis-contradiction-runner: 分层仓位证据：核心多头 + 空头对冲.",
        tags: ["meaning_gate", "sensor_firewall", "external_feedback"],
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 0);
  assert.equal(result.totalClaims, 0);
  assert.equal(result.excludedAsNonConflict.count, 1);
  assert.equal(result.excludedAsNonConflict.reasonCounts.sensor_firewall_audit_wrapper, 1);
});

test("faithfulness reports low coverage and unavailable evidence honestly", () => {
  const lowCoverage = evaluateFaithfulness({
    evidenceCorpus: ["看多优先：目标公司收入增速与自由现金流修复共振。"],
    knowledgeItems: [
      {
        id: "kb_sample_0001_long_support",
        sourceRef: "equity-thesis-contradiction-runner:sample_0001_long_support",
        tags: ["long_thesis_score>=0.78"],
        status: "active",
        content: [
          "需要后续人工复查。",
          "看多优先：目标公司收入增速与自由现金流修复共振。",
          "这是一条没有确定性锚点的流程备注。",
        ].join("\n"),
      },
    ],
  });
  assert.equal(lowCoverage.status, "low_coverage");
  assert.equal(lowCoverage.blockingEligible, false);
  assert.equal(lowCoverage.scoreableCoverage, 1);
  assert.equal(lowCoverage.scoreableKnowledgeItems, 1);
  assert.equal(lowCoverage.eligible, 1);
  assert.equal(lowCoverage.indeterminateReasonCounts.no_deterministic_anchor, 2);

  const unavailable = evaluateFaithfulness({
    evidenceCorpus: [],
    knowledgeItems: [
      {
        id: "kb_sample_0005_tiered_support",
        sourceRef: "equity-thesis-contradiction-runner:sample_0005_tiered_support",
        status: "active",
        content: [
          "分层仓位方案：核心多头捕捉基本面上行，空头或现金对冲用于财报波动。",
          "tiered_thesis_confidence >= 0.81。",
          "当前最优仓位决策：多空分层仓位方案，置信度 0.71。",
        ].join("\n"),
      },
    ],
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.faithfulness, null);
  assert.equal(unavailable.blockingEligible, false);
});

test("rssSlopeMbPerHour computes linear memory slope", () => {
  const slope = rssSlopeMbPerHour([
    { epoch: 1000, appRssMb: 100 },
    { epoch: 1000 + 3600, appRssMb: 125 },
    { epoch: 1000 + 7200, appRssMb: 150 },
  ]);

  assert.equal(slope, 25);
});
