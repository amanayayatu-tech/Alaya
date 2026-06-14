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

function hybridSupportKnowledge(index, overrides = {}) {
  const sampleId = String(index + 1).padStart(4, "0");
  return {
    id: `kb_proj_runtime_${String(index).padStart(3, "0")}`,
    sourceRef: `health-signal-contradiction-runner:sample_${sampleId}_hybrid_support`,
    content: [
      "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
      "hybrid_decision_confidence >= 0.81。",
      "明确冲突：该结论与混合方案反证互相矛盾，不能同时作为 active 知识复用。",
      "当前最优选型决策：PPG+ECG 分层方案，置信度 1.0。",
    ].join("\n"),
    status: "active",
    confidence_score: 1,
    ...overrides,
  };
}

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

test("decisionTsr includes implemented passK when aggregate data is supplied", () => {
  const result = evaluateDecisionTsr([
    {
      id: "kb_gate_sample_0005_hybrid_support",
      content: "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
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

test("resolutionAccuracy deducts wrong winners for every expanded tier rule", () => {
  const cases = [
    {
      name: "T1 beats T2",
      primaryKnowledgeId: "kb_sample_hybrid_support",
      relatedKnowledgeId: "kb_sample_ppg_risk",
      survivorKnowledgeId: "kb_sample_ppg_risk",
      expectedRule: "hybrid_support_beats_ppg_risk",
    },
    {
      name: "T1 beats T3",
      primaryKnowledgeId: "kb_sample_hybrid_support",
      relatedKnowledgeId: "kb_sample_ecg_support",
      survivorKnowledgeId: "kb_sample_ecg_support",
      expectedRule: "hybrid_support_beats_ecg_support",
    },
    {
      name: "T1 beats T4",
      primaryKnowledgeId: "kb_sample_hybrid_support",
      relatedKnowledgeId: "kb_sample_hybrid_reject",
      survivorKnowledgeId: "kb_sample_hybrid_reject",
      expectedRule: "hybrid_support_beats_hybrid_reject",
    },
    {
      name: "T2 beats cross-family T3",
      primaryKnowledgeId: "kb_sample_ecg_risk",
      relatedKnowledgeId: "kb_sample_ppg_support",
      survivorKnowledgeId: "kb_sample_ppg_support",
      expectedRule: "ecg_risk_beats_ppg_support",
    },
    {
      name: "T2 beats T4",
      primaryKnowledgeId: "kb_sample_ppg_risk",
      relatedKnowledgeId: "kb_sample_hybrid_reject",
      survivorKnowledgeId: "kb_sample_hybrid_reject",
      expectedRule: "ppg_risk_beats_hybrid_reject",
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
      primaryKnowledgeId: "kb_sample_0001_ecg_risk",
      relatedKnowledgeId: "kb_sample_0007_ecg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0007_ecg_risk",
    },
  ]);
  assert.equal(good.status, "pass");
  assert.equal(good.scored, 1);
  assert.equal(good.correct, 1);
  assert.equal(good.scoredEvents[0].resolutionDuplicatePair, true);
  assert.equal(good.duplicatePairTypeCounts["ecg_risk|ecg_risk"], 1);

  const bad = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_dedupe_bad",
      primaryKnowledgeId: "kb_sample_0001_ecg_risk",
      relatedKnowledgeId: "kb_sample_0007_ecg_risk",
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
      primaryKnowledgeId: "kb_sample_0001_ecg_risk",
      relatedKnowledgeId: "kb_sample_0007_ecg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_0007_ecg_risk",
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
  assert.equal(result.unscoredPairTypeCounts["unknown|unknown"], 2);
  assert.equal(result.unscoredReasonCounts.unknown_oracle_side, 2);
});

test("resolutionAccuracy keeps deliberately ambiguous pairs unscored", () => {
  const result = scoreResolutionAccuracy([
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t2_t2",
      primaryKnowledgeId: "kb_sample_ppg_risk",
      relatedKnowledgeId: "kb_sample_ecg_risk",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_ecg_risk",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t3_t3",
      primaryKnowledgeId: "kb_sample_ppg_support",
      relatedKnowledgeId: "kb_sample_ecg_support",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_ecg_support",
    },
    {
      eventType: "knowledge_review_resolved",
      reviewId: "kr_t3_t4",
      primaryKnowledgeId: "kb_sample_ppg_support",
      relatedKnowledgeId: "kb_sample_hybrid_reject",
      action: "merge_supersede",
      survivorKnowledgeId: "kb_sample_hybrid_reject",
    },
  ]);

  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.scored, 0);
  assert.equal(result.unscored, 3);
  assert.equal(result.unscoredReasonCounts.ambiguous_same_layer_t2_risk_pair, 1);
  assert.equal(result.unscoredReasonCounts.ambiguous_same_layer_t3_support_pair, 1);
  assert.equal(result.unscoredReasonCounts.ambiguous_t3_support_vs_t4_hybrid_reject, 1);
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
      id: "kb_sample_0005_hybrid_support",
      sourceRef: "health-signal-contradiction-runner:sample_0005_hybrid_support",
      title: "混合方案证据：PPG 连续 + ECG 复核",
      content: [
        "混合方案证据：PPG 连续 + ECG 复核。",
        "hybrid_decision_confidence >= 0.81。",
        "明确冲突：该结论与混合方案反证互相矛盾。",
        "当前最优选型决策：PPG+ECG 分层方案，置信度 0.8。",
      ].join("\n"),
      status: "active",
      supersededBy: null,
      confidence_score: 0.8,
    },
    {
      id: "kb_sample_0001_ppg_support",
      sourceRef: "health-signal-contradiction-runner:sample_0001_ppg_support",
      title: "PPG 优先证据",
      content: [
        "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低。",
        "ppg_priority_score >= 0.78。",
        "明确冲突：该结论与 ECG 优先互相矛盾。",
        "当前最优选型决策：优先 PPG，置信度 0.6。",
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
      id: "kb_sample_0005_hybrid_support",
      sourceRef: "health-signal-contradiction-runner:sample_0005_hybrid_support",
      content: [
        "混合方案证据：PPG 连续 + ECG 复核。",
        "hybrid_decision_confidence >= 0.81。",
        "明确冲突：该结论与混合方案反证互相矛盾。",
        "当前最优选型决策：PPG+ECG 分层方案，置信度 1.0。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_generic_unknown",
      content: "没有 oracle side 的普通知识，置信度 0.7。",
      status: "active",
    },
    {
      id: "kb_proj_ppg_risk_missing_confidence",
      content: [
        "PPG 风险来自肤色、佩戴松紧、环境光和运动伪影。",
        "ppg_priority_score <= 0.42。",
        "明确冲突：该证据削弱之前 PPG 优先结论。",
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
      id: "kb_proj_ecg_risk_missing_confidence",
      content: [
        "ECG 风险来自电极接触和主动测量交互。",
        "ppg_priority_score >= 0.72。",
        "明确冲突：该证据反驳 ECG 优先。",
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
      content: "目标用户 35-50 岁，价格锚定 ¥899，续航红线为 7 天，置信度 0.95。",
      status: "active",
    },
    {
      id: "kb_proj_market_context",
      title: "种子身份",
      content: "当前最优选型决策：PPG+ECG 分层方案。须通过 NMPA 三类审批，遇 PPG/ECG 矛盾必须等待人工审核，budget_throttle_effectiveness >= 0.85，置信度 0.88。",
      status: "active",
      tags: ["identity", "seed"],
      supersededBy: "kb_seed_identity_001",
    },
    {
      id: "kb_proj_conflict_hybrid",
      content: [
        "混合方案证据：PPG 连续趋势 + ECG 二次复核。",
        "hybrid_decision_confidence >= 0.81。",
        "明确冲突：该结论与混合方案反证互相矛盾。",
        "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
      ].join("\n"),
      status: "active",
      confidence_score: 0.71,
    },
    {
      id: "kb_sample_0002_ecg_support",
      sourceRef: "health-signal-contradiction-runner:sample_0002_ecg_support",
      content: [
        "ECG 优先：心电信号更可解释。",
        "ppg_priority_score <= 0.35。",
        "明确冲突：该结论与 PPG 优先互相矛盾。",
        "当前最优选型决策：优先 ECG，置信度 0.66。",
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
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_proj_conflict_hybrid").correct, true);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_sample_0002_ecg_support").correct, false);
});

test("confidenceCalibration excludes sensor firewall audit wrappers from oracle calibration", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_gate_gate_sensor_recurring_1234",
      sourceRef: "health-signal-contradiction-runner:sample_0029_hybrid_support",
      title: "外部反馈: recurring sensor error unknown from health-signal-contradiction-runner",
      content: "Human approved meaning gate gate_sensor_recurring_1234.",
      status: "strong",
      confidence_score: 0.98,
      tags: ["meaning_gate", "sensor_firewall", "external_feedback"],
    },
    {
      id: "kb_gate_sample_0004_ecg_risk",
      sourceRef: "health-signal-contradiction-runner:sample_0004_ecg_risk",
      content: [
        "ECG 风险：ECG 需要更严格电极接触和主动测量交互，连续 7 天续航与 ¥899 定价下硬件和体验成本更高。",
        "ppg_priority_score >= 0.72。",
        "明确冲突：该证据反驳 ECG 优先，必须隔离到冲突审查流程。",
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
  assert.equal(result.scoredKnowledge[0].knowledgeId, "kb_gate_sample_0004_ecg_risk");
});

test("confidenceCalibration parses decision brief and template fallback confidence without changing correctness", () => {
  const result = evaluateConfidenceCalibration([
    {
      id: "kb_sample_0005_hybrid_support",
      sourceRef: "health-signal-contradiction-runner:sample_0005_hybrid_support",
      content: [
        "混合方案仍是最终决策。",
        "hybrid_decision_confidence >= 0.81。",
        "明确冲突：该结论与混合方案反证互相矛盾。",
        "当前最优选型决策：PPG+ECG 分层方案。",
      ].join("\n"),
      status: "active",
      decision_brief: {
        claim: "混合方案仍是最终决策",
        confidence: 0.72,
      },
    },
    {
      id: "kb_gate_sample_0001_ppg_support",
      sourceRef: "health-signal-contradiction-runner:sample_0001_ppg_support",
      content: [
        "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低。",
        "ppg_priority_score >= 0.78。",
        "明确冲突：该结论与 ECG 优先互相矛盾。",
        "当前最优选型决策：优先 PPG。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_proj_ecg_risk_missing_confidence",
      content: [
        "ECG 风险存在，但缺少置信度。",
        "ppg_priority_score >= 0.72。",
        "明确冲突：该证据反驳 ECG 优先。",
      ].join("\n"),
      status: "active",
    },
    {
      id: "kb_proj_hybrid_reject_missing_confidence",
      content: [
        "混合方案反证存在，但缺少置信度。",
        "hybrid_decision_confidence <= 0.38。",
        "明确冲突：该结论与混合方案推荐互相矛盾。",
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
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_sample_0005_hybrid_support").confidence, 0.72);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_gate_sample_0001_ppg_support").confidence, 0.64);
  assert.equal(result.scoredKnowledge.find((item) => item.knowledgeId === "kb_gate_sample_0001_ppg_support").correct, false);
});

test("confidenceCalibration only blocks when eligible coverage and sample count are sufficient", () => {
  const passResult = evaluateConfidenceCalibration(
    Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => hybridSupportKnowledge(index)),
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
      id: `kb_proj_wrong_ppg_${String(index).padStart(3, "0")}`,
      content: [
        "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低。",
        "ppg_priority_score >= 0.78。",
        "明确冲突：该结论与 ECG 优先互相矛盾。",
        "当前最优选型决策：优先 PPG，置信度 1.0。",
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
        ? hybridSupportKnowledge(index)
        : hybridSupportKnowledge(index, {
          sourceRef: "",
          confidence_score: undefined,
          content: [
            "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
            "hybrid_decision_confidence >= 0.81。",
            "明确冲突：该结论与混合方案反证互相矛盾，不能同时作为 active 知识复用。",
            "当前最优选型决策：PPG+ECG 分层方案。",
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
        "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
        "hybrid_decision_confidence >= 0.81。",
        "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
      ].join("\n"),
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0005_hybrid_support",
        sourceRef: "health-signal-contradiction-runner:sample_0005_hybrid_support",
        status: "active",
        content: [
          "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
          "hybrid_decision_confidence >= 0.81。",
          "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
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
      "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
      "ppg_priority_score >= 0.78。",
      "明确冲突：该结论与 ECG 优先互相矛盾。",
      "当前最优选型决策：优先 PPG，置信度 0.64。",
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0001_ppg_support",
        sourceRef: "health-signal-contradiction-runner:sample_0001_ppg_support",
        status: "active",
        content: [
          "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
          "ppg_priority_score >= 0.78。",
          "明确冲突：该结论与 ECG 优先互相矛盾。",
          "当前最优选型决策：优先 PPG，置信度 0.64。",
          "新增主张：已经完成 FDA Class III 认证，置信度 0.92。",
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.status, "low_coverage");
  assert.equal(result.blockingEligible, false);
  assert.equal(result.supported, 4);
  assert.equal(result.unsupported, 1);
  assert.equal(result.hallucinationRate, 0.2);
  assert.match(result.unsupportedClaims[0].claim, /FDA Class III/);
});

test("faithfulness scores Chinese domain phrases without numeric anchors and still catches unsupported claims", () => {
  const result = evaluateFaithfulness({
    evidenceCorpus: [
      "PPG 风险：肤色、佩戴松紧、环境光和运动伪影会影响 PPG 静息心率可靠性，ppg_priority_score <= 0.42。",
      "建议：保留 PPG 作为低功耗连续趋势传感器，但医疗级判定需要 ECG 或人工复核。",
    ],
    knowledgeItems: [
      {
        id: "kb_sample_0003_ppg_risk",
        sourceRef: "health-signal-contradiction-runner:sample_0003_ppg_risk",
        status: "active",
        content: [
          "PPG 风险来自肤色、佩戴松紧、环境光和运动伪影，ppg_priority_score <= 0.42。",
          "新增主张：PPG 风险已经完成 FDA Class III 认证。",
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
  assert.match(result.unsupportedClaims[0].claim, /FDA Class III/);
  assert.ok(result.unsupportedClaims[0].anchors.some((anchor) => /fda class iii/.test(anchor)));
});

test("faithfulness only blocks when eligible knowledge coverage and sample count are sufficient", () => {
  const evidenceCorpus = [
    "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核和医疗级证据补强。",
    "hybrid_decision_confidence >= 0.81。",
    "明确冲突：该结论与混合方案反证互相矛盾，不能同时作为 active 知识复用。",
    "当前最优选型决策：PPG+ECG 分层方案，置信度 1.0。",
    "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
    "ppg_priority_score >= 0.78。",
    "明确冲突：该结论与 ECG 优先互相矛盾。",
    "当前最优选型决策：优先 PPG，置信度 0.64。",
  ];
  const passResult = evaluateFaithfulness({
    evidenceCorpus,
    knowledgeItems: Array.from({ length: CONFLICT_QUALITY_MIN_ELIGIBLE }, (_, index) => hybridSupportKnowledge(index)),
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
      id: `kb_proj_ppg_support_${String(index).padStart(3, "0")}`,
      status: "active",
      content: [
        "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
        "ppg_priority_score >= 0.78。",
        "明确冲突：该结论与 ECG 优先互相矛盾。",
        "当前最优选型决策：优先 PPG，置信度 0.64。",
        "新增主张：已经完成 FDA Class III 认证，置信度 0.92。",
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
        ? hybridSupportKnowledge(index)
        : {
          id: `kb_proj_sparse_hybrid_support_${String(index).padStart(3, "0")}`,
          sourceRef: `health-signal-contradiction-runner:sample_${String(index + 1).padStart(4, "0")}_hybrid_support`,
          status: "active",
          tags: ["hybrid_decision_confidence>=0.81"],
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
      "PPG 风险：肤色、佩戴松紧、环境光和运动伪影会影响 PPG 静息心率可靠性，ppg_priority_score <= 0.42。",
      "当前最优选型决策：PPG+ECG 分层方案。须通过 NMPA 三类审批，遇 PPG/ECG 矛盾必须等待人工审核。",
    ],
    knowledgeItems: [
      {
        id: "kb_seed_world_001",
        status: "active",
        content: "目标用户 35-50 岁，价格锚定 ¥899，必须达到 7 天续航。",
      },
      {
        id: "kb_proj_regulatory_context",
        title: "种子世界",
        status: "active",
        tags: ["world", "seed"],
        supersededBy: "kb_seed_world_001",
        content: "当前最优选型决策：PPG+ECG 分层方案。须通过 NMPA 三类审批，遇 PPG/ECG 矛盾必须等待人工审核，risk_gate_recovery_proof_coverage >= 0.85。",
      },
      {
        id: "kb_sample_0003_ppg_risk",
        sourceRef: "health-signal-contradiction-runner:sample_0003_ppg_risk",
        status: "active",
        content: "PPG 风险来自肤色、佩戴松紧、环境光和运动伪影，ppg_priority_score <= 0.42。",
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
      "ECG 反证：功耗/交互/成本压力。",
      "ECG 风险：ECG 需要更严格电极接触和主动测量交互，连续 7 天续航与 ¥899 定价下硬件和体验成本更高。",
      "ppg_priority_score >= 0.72。",
      "明确冲突：该证据反驳 ECG 优先，必须隔离到冲突审查流程。",
    ],
    knowledgeItems: [
      {
        id: "kb_gate_sample_0004_ecg_risk",
        sourceRef: "health-signal-contradiction-runner:sample_0004_ecg_risk",
        title: "外部反馈: ECG 反证：功耗/交互/成本压力",
        status: "strong",
        content: [
          "Human approved meaning gate gate_ext_fb_form_sample_0004_ecg_risk.",
          "Source: form_feedback sample_0004_ecg_risk.",
          "Summary: ECG 反证：功耗/交互/成本压力.",
          "User quote: Form Feedback (health-signal-contradiction-runner sample_0004_ecg_risk): ECG 风险：ECG 需要更严格电极接触和主动测量交互，连续 7 天续航与 ¥899 定价下硬件和体验成本更高。\nppg_priority_score >= 0.72。\n明确冲突：该证据反驳 ECG 优先，必须隔离到冲突审查流程。",
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
      "混合方案证据：PPG 连续 + ECG 复核。",
    ],
    knowledgeItems: [
      {
        id: "kb_gate_gate_sensor_recurring_1234",
        sourceRef: "health-signal-contradiction-runner:sample_0029_hybrid_support",
        title: "外部反馈: recurring sensor error unknown from health-signal-contradiction-runner",
        status: "strong",
        content: "User quote: recurring sensor error unknown from health-signal-contradiction-runner: 混合方案证据：PPG 连续 + ECG 复核.",
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
    evidenceCorpus: ["PPG 优先：光学 PPG 在静息心率监测下功耗低。"],
    knowledgeItems: [
      {
        id: "kb_sample_0001_ppg_support",
        sourceRef: "health-signal-contradiction-runner:sample_0001_ppg_support",
        tags: ["ppg_priority_score>=0.78"],
        status: "active",
        content: [
          "需要后续人工复查。",
          "PPG 优先：光学 PPG 在静息心率监测下功耗低。",
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
        id: "kb_sample_0005_hybrid_support",
        sourceRef: "health-signal-contradiction-runner:sample_0005_hybrid_support",
        status: "active",
        content: [
          "混合方案：PPG 用于低功耗连续静息心率趋势，ECG 用于疑似异常时主动复核。",
          "hybrid_decision_confidence >= 0.81。",
          "当前最优选型决策：PPG+ECG 分层方案，置信度 0.71。",
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
