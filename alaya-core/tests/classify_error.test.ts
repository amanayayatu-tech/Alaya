import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, routeError } from "../src/core/classify_error.js";
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
