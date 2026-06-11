import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, classifyErrorWithConfidence, routeError } from "../src/core/classify_error.js";
import type { AttributionContext } from "../src/core/types.js";

const base: AttributionContext = {
  perceptionFailure: false,
  executionFailure: false,
  humanFlaggedValueMismatch: false,
  isQualitative: false,
};

test("归因决策树按固定顺序:perception 最优先", () => {
  // 即使同时有执行失败,perception 优先
  assert.equal(classifyError(0.9, { ...base, perceptionFailure: true, executionFailure: true }), "perception");
});

test("execution 次之", () => {
  assert.equal(classifyError(0.9, { ...base, executionFailure: true }), "execution");
});

test("value:指标达标但人类标记方向不对", () => {
  // 误差很低(达标)但人类标记 value mismatch
  assert.equal(classifyError(0.1, { ...base, humanFlaggedValueMismatch: true }), "value");
});

test("model:其余且误差超阈值", () => {
  assert.equal(classifyError(0.8, base), "model");
});

test("误差未超阈值且无其他信号 => null(无显著误差)", () => {
  assert.equal(classifyError(0.2, base), null);
});

test("qualitative 不进入自动归因", () => {
  assert.equal(classifyError(0.9, { ...base, isQualitative: true }), null);
});

test("误差路由正确", () => {
  assert.equal(routeError("perception"), "update_data_source");
  assert.equal(routeError("execution"), "builder_fix_queue");
  assert.equal(routeError("model"), "distiller_world_model_update");
  assert.equal(routeError("value"), "human_meaning_or_direction_gate");
});

test("classifyError contract matrix remains unchanged", () => {
  assert.equal(classifyError(0.9, {
    perceptionFailure: true,
    executionFailure: true,
    humanFlaggedValueMismatch: true,
    isQualitative: true,
  }), null);
  assert.equal(classifyError(0.9, { ...base, perceptionFailure: true, executionFailure: true }), "perception");
  assert.equal(classifyError(0.9, { ...base, executionFailure: true, humanFlaggedValueMismatch: true }), "execution");
  assert.equal(classifyError(0.9, { ...base, humanFlaggedValueMismatch: true }), "value");
  assert.equal(classifyError(0.5, base), null);
  assert.equal(classifyError(0.500001, base), "model");
  assert.equal(routeError(null), "no_action_or_meaning_gate");
});

test("classifyErrorWithConfidence wraps the original decision and route", () => {
  const cases: Array<[number | null, AttributionContext]> = [
    [0.9, base],
    [0.2, base],
    [0.9, { ...base, perceptionFailure: true, executionFailure: true }],
    [0.55, { ...base, executionFailure: true }],
    [0.45, { ...base, humanFlaggedValueMismatch: true }],
    [0.9, { ...base, isQualitative: true }],
  ];
  for (const [claimError, ctx] of cases) {
    const direct = classifyError(claimError, ctx);
    const wrapped = classifyErrorWithConfidence(claimError, ctx);
    assert.equal(wrapped.errorType, direct);
    assert.equal(wrapped.route, routeError(direct));
  }
});

test("classifyErrorWithConfidence penalizes multiple attribution signals", () => {
  assert.deepEqual(classifyErrorWithConfidence(0.8, { ...base, perceptionFailure: true }), {
    errorType: "perception",
    route: "update_data_source",
    attributionConfidence: 1,
    lowConfidenceReasons: [],
  });

  const twoSignals = classifyErrorWithConfidence(0.8, { ...base, perceptionFailure: true, executionFailure: true });
  assert.equal(twoSignals.errorType, "perception");
  assert.equal(twoSignals.attributionConfidence, 0.8);
  assert.deepEqual(twoSignals.lowConfidenceReasons, ["multiple_attribution_signals"]);

  const threeSignals = classifyErrorWithConfidence(0.8, {
    ...base,
    perceptionFailure: true,
    executionFailure: true,
    humanFlaggedValueMismatch: true,
  });
  assert.equal(threeSignals.errorType, "perception");
  assert.equal(threeSignals.attributionConfidence, 0.6);
  assert.deepEqual(threeSignals.lowConfidenceReasons, ["multiple_attribution_signals"]);
});

test("classifyErrorWithConfidence penalizes model-threshold boundary", () => {
  const below = classifyErrorWithConfidence(0.45, base);
  assert.equal(below.errorType, null);
  assert.equal(below.attributionConfidence, 0.85);
  assert.deepEqual(below.lowConfidenceReasons, ["near_model_error_threshold"]);

  const at = classifyErrorWithConfidence(0.5, base);
  assert.equal(at.errorType, null);
  assert.equal(at.attributionConfidence, 0.85);

  const above = classifyErrorWithConfidence(0.55, base);
  assert.equal(above.errorType, "model");
  assert.equal(above.attributionConfidence, 0.85);

  assert.equal(classifyErrorWithConfidence(0.39, base).attributionConfidence, 1);
  assert.equal(classifyErrorWithConfidence(0.61, base).attributionConfidence, 1);
});

test("classifyErrorWithConfidence combines multiple-signal and boundary reasons", () => {
  const result = classifyErrorWithConfidence(0.55, { ...base, perceptionFailure: true, executionFailure: true });
  assert.equal(result.errorType, "perception");
  assert.equal(result.attributionConfidence, 0.65);
  assert.deepEqual(result.lowConfidenceReasons, ["multiple_attribution_signals", "near_model_error_threshold"]);
});
