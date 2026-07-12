import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConfidenceCalibration,
  evaluateDecisionTsr,
  evaluateFaithfulness,
  evaluateLearningLoopMetrics,
  summarizeEquityThesisQuality,
} from "../lib/health-signal-quality.mjs";

function learningEvent(index, { correct, pool = "train", ruleId = "R1", confidence = 0.8 } = {}) {
  return {
    eventType: "learning_case_resolved",
    cycleId: `cycle_${String(index).padStart(3, "0")}`,
    cycleIdx: index,
    caseId: `case_${String(index).padStart(3, "0")}`,
    pool,
    ruleId,
    predictedDecision: correct ? "increase_long" : "avoid_trade",
    groundTruthDecision: "increase_long",
    confidence,
  };
}

function injectionTrace(index, injected) {
  return {
    kind: "knowledge_injection",
    name: "build_prior_knowledge_context",
    cycleId: `cycle_${String(index).padStart(3, "0")}`,
    attributes: {
      candidateIds: ["kb_helpful"],
      injectedKnowledgeIds: injected ? ["kb_helpful"] : [],
      droppedKnowledgeId: injected ? null : "kb_helpful",
    },
  };
}

function oracleAnswers(count) {
  return {
    answers: Array.from({ length: count }, (_, index) => ({
      caseId: `case_${String(index + 1).padStart(3, "0")}`,
      oracleDecision: "increase_long",
      groundTruthDecision: "increase_long",
    })),
  };
}

function monotonicEvents() {
  const events = [];
  let index = 1;
  for (let block = 0; block < 10; block += 1) {
    const correctInBlock = block + 1;
    for (let offset = 0; offset < 10; offset += 1) {
      const correct = offset < correctInBlock;
      const pool = index > 80 ? "heldout" : "train";
      events.push(learningEvent(index, {
        correct,
        pool,
        ruleId: `R${(index % 4) + 1}`,
        confidence: correct ? 0.82 : 0.68,
      }));
      events.push(injectionTrace(index, index > 50));
      index += 1;
    }
  }
  return events;
}

test("monotonic synthetic run produces significant positive learningCurve trend", () => {
  const metrics = evaluateLearningLoopMetrics({
    events: monotonicEvents(),
    oracleAnswers: oracleAnswers(100),
    blockSize: 10,
  });

  assert.equal(metrics.learningCurve.status, "OK");
  assert.equal(metrics.learningCurve.accuracyTrend.direction, "positive");
  assert.equal(metrics.learningCurve.accuracyTrend.significant, true);
  assert.ok(metrics.learningCurve.accuracyTrend.pValue < 0.05);
  assert.equal(metrics.cumulativeRegret.status, "OK");
  assert.equal(metrics.cumulativeRegret.tailSlopeBelowHeadSlope, true);
  assert.equal(metrics.knowledgeROI.status, "OK");
  assert.equal(metrics.heldOutAccuracy.status, "OK");
  assert.equal(metrics.forgettingRate.status, "OK");
});

test("no-improvement synthetic run does not create a false positive trend", () => {
  const events = [];
  for (let index = 1; index <= 100; index += 1) {
    const correct = index % 2 === 0;
    events.push(learningEvent(index, { correct, pool: index > 80 ? "heldout" : "train", ruleId: "R_flat" }));
  }

  const metrics = evaluateLearningLoopMetrics({
    events,
    oracleAnswers: oracleAnswers(100),
    blockSize: 10,
  });

  assert.equal(metrics.learningCurve.status, "OK");
  assert.equal(metrics.learningCurve.accuracyTrend.significant, false);
  assert.ok(metrics.learningCurve.accuracyTrend.pValue >= 0.05);
});

test("heldOutAccuracy counts heldout pool without contaminating train pool counts", () => {
  const events = [];
  for (let index = 1; index <= 10; index += 1) {
    events.push(learningEvent(index, { correct: false, pool: "train", ruleId: "R_train" }));
  }
  for (let index = 11; index <= 20; index += 1) {
    events.push(learningEvent(index, { correct: index <= 18, pool: "heldout", ruleId: "R_heldout" }));
  }

  const metrics = evaluateLearningLoopMetrics({
    events,
    oracleAnswers: oracleAnswers(20),
    blockSize: 5,
  });

  assert.equal(metrics.heldOutAccuracy.status, "OK");
  assert.equal(metrics.heldOutAccuracy.heldoutScored, 10);
  assert.equal(metrics.heldOutAccuracy.trainScored, 10);
  assert.equal(metrics.heldOutAccuracy.heldOutAccuracy, 0.8);
  assert.equal(metrics.heldOutAccuracy.trainAccuracy, 0);
});

test("knowledgeROI excludes heldout outcomes and traces while heldOutAccuracy still scores them", () => {
  const events = [];
  for (let index = 1; index <= 12; index += 1) {
    events.push(learningEvent(index, { correct: index % 2 === 0, pool: "train", ruleId: "R_train" }));
    events.push(injectionTrace(index, index <= 6));
  }
  for (let index = 13; index <= 18; index += 1) {
    events.push({
      ...learningEvent(index, { correct: true, pool: "heldout", ruleId: "R_heldout" }),
      excludeFromDistiller: true,
      excludeFromCreditTraining: true,
    });
    events.push(injectionTrace(index, true));
  }

  const metrics = evaluateLearningLoopMetrics({
    events,
    oracleAnswers: oracleAnswers(18),
    blockSize: 5,
  });

  assert.equal(metrics.heldOutAccuracy.heldoutScored, 6);
  assert.equal(metrics.knowledgeROI.eligiblePool, "train");
  assert.equal(metrics.knowledgeROI.trainingOutcomeCount, 12);
  assert.equal(metrics.knowledgeROI.excludedHeldoutCount, 6);
  assert.equal(metrics.knowledgeROI.trainingOutcomeCaseIds.some((caseId) => Number(caseId.slice(-3)) > 12), false);
  assert.equal(metrics.knowledgeROI.sourceRows.some((row) => Number(row.cycleId.slice(-3)) > 12), false);
});

test("new learning metrics report LOW_COVERAGE without attractive point estimates", () => {
  const metrics = evaluateLearningLoopMetrics({
    events: [
      learningEvent(1, { correct: true, pool: "heldout", ruleId: "R_low" }),
      injectionTrace(1, true),
    ],
    oracleAnswers: oracleAnswers(1),
    blockSize: 10,
  });

  assert.equal(metrics.learningCurve.status, "LOW_COVERAGE");
  assert.deepEqual(metrics.learningCurve.accuracySeries, []);
  assert.deepEqual(metrics.learningCurve.brierSeries, []);
  assert.equal(metrics.cumulativeRegret.status, "LOW_COVERAGE");
  assert.deepEqual(metrics.cumulativeRegret.cumulativeErrorCurve, []);
  assert.equal(metrics.knowledgeROI.status, "LOW_COVERAGE");
  assert.equal(metrics.knowledgeROI.deltaDistribution, null);
  assert.equal(metrics.heldOutAccuracy.status, "LOW_COVERAGE");
  assert.equal(metrics.heldOutAccuracy.heldOutAccuracy, null);
  assert.equal(metrics.forgettingRate.status, "LOW_COVERAGE");
  assert.equal(metrics.forgettingRate.forgettingRate, null);
});

test("existing ECE, decisionTsr, and faithfulness outputs remain unchanged", () => {
  const knowledgeItems = [{
    id: "kb_gate_sample_0005_tiered_support",
    title: "分层仓位证据：核心多头 + 空头对冲",
    content: [
      "分层仓位证据：核心多头 + 空头对冲。",
      "tiered_thesis_confidence >= 0.81。",
      "明确冲突：该结论与分层仓位反证互相矛盾。",
      "当前最优仓位决策：多空分层仓位方案，置信度 0.8。",
    ].join("\n"),
    status: "active",
    confidence_score: 0.8,
  }];
  const events = [{
    eventType: "contradiction_feedback_injected",
    externalId: "sample_0005_tiered_support",
    evidenceText: knowledgeItems[0].content,
  }];

  const summary = summarizeEquityThesisQuality({ knowledgeItems, events });

  assert.deepEqual(summary.decisionTsr, evaluateDecisionTsr(knowledgeItems));
  assert.deepEqual(summary.confidenceCalibration, evaluateConfidenceCalibration(knowledgeItems, { events }));
  assert.deepEqual(summary.faithfulness, evaluateFaithfulness({ knowledgeItems, events }));
});
