import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMetricError,
  computeClaimError,
  computeCycleError,
} from "../src/core/compute_error.js";
import type { Claim } from "../src/core/types.js";

test("达标/超额完成误差为 0", () => {
  assert.equal(computeMetricError(0.3, 0.4, ">="), 0); // 超额
  assert.equal(computeMetricError(0.3, 0.3, ">="), 0); // 刚好
});

test("未达标误差随差距增大", () => {
  assert.equal(computeMetricError(0.3, 0.15, ">=", 0.3), 0.5);
  assert.equal(computeMetricError(0.3, 0.0, ">=", 0.3), 1.0);
});

// ---- 漏洞A:越小越好指标 ----
test("漏洞A修复:越小越好指标(<=)达标时误差为 0", () => {
  // bug_rate <= 0.05,实际 0.02 达标 => 误差必须是 0
  assert.equal(computeMetricError(0.05, 0.02, "<="), 0);
});

test("漏洞A:越小越好指标超标时误差>0", () => {
  // bug_rate <= 0.05,实际 0.10 超标 => 误差>0
  const e = computeMetricError(0.05, 0.1, "<=", 0.05);
  assert.ok(e > 0, `期望>0,实际 ${e}`);
  assert.equal(e, 1.0); // (0.1-0.05)/0.05 = 1.0
});

// ---- 漏洞B:T=0 除零 ----
test("漏洞B修复:目标值为 0 不除零崩溃", () => {
  const e = computeMetricError(0, 5, "<=");
  assert.ok(Number.isFinite(e), "误差必须是有限数");
  assert.equal(e, 1.0); // 偏离上限被 clip 到 1
});

test("== 操作符双向偏离都算误差", () => {
  assert.equal(computeMetricError(10, 10, "=="), 0);
  assert.equal(computeMetricError(10, 5, "==", 5), 1.0);
  assert.equal(computeMetricError(10, 15, "==", 5), 1.0);
});

// ---- 漏洞G:离散 claim 类型 ----
test("漏洞G:binary claim 命中 0 未命中 1", () => {
  const hit: Claim = { id: "c", type: "binary", expected: "released", actual: "released", weight: 1 };
  const miss: Claim = { id: "c", type: "binary", expected: "released", actual: "failed", weight: 1 };
  assert.equal(computeClaimError(hit), 0);
  assert.equal(computeClaimError(miss), 1);
});

test("漏洞G:directional 方向对0/反向1/持平0.5", () => {
  const base = { id: "c", type: "directional" as const, expectedDirection: "up" as const, weight: 1 };
  assert.equal(computeClaimError({ ...base, actualDirection: "up" }), 0);
  assert.equal(computeClaimError({ ...base, actualDirection: "down" }), 1);
  assert.equal(computeClaimError({ ...base, actualDirection: "flat" }), 0.5);
});

test("qualitative claim 不自动计算,返回 null", () => {
  const q: Claim = { id: "c", type: "qualitative", weight: 1 };
  assert.equal(computeClaimError(q), null);
});

// ---- 漏洞C:大错不被稀释 ----
test("漏洞C:E_cycle 同时暴露 worstClaimError", () => {
  // 9个小错+1个完全失败,权重相同
  const claims: Claim[] = [];
  for (let i = 0; i < 9; i++) {
    claims.push({ id: `s${i}`, type: "metric_threshold", operator: ">=", target: 1, observed: 0.9, scale: 1, weight: 1 });
  }
  claims.push({ id: "big", type: "binary", expected: "ok", actual: "fail", weight: 1 });
  const r = computeCycleError(claims);
  // E_cycle 会稀释,但 worstClaimError 必须捕捉到那个 1.0
  assert.equal(r.worstClaimError, 1.0);
  assert.ok(r.eCycle! < 0.2, "平方加权确实稀释了大错(这正是为何需要worst)");
  assert.equal(r.scoredClaims, 10);
});

test("漏洞C:关键claim高权重可主导E_cycle", () => {
  const claims: Claim[] = [
    { id: "minor", type: "metric_threshold", operator: ">=", target: 1, observed: 0.95, scale: 1, weight: 1 },
    { id: "key", type: "binary", expected: "ok", actual: "fail", weight: 3 }, // weight>=3
  ];
  const r = computeCycleError(claims);
  // key 误差1.0 weight3 => 3*1 / (1+3) = 0.75 主导
  assert.ok(r.eCycle! > 0.7, `关键预测失败应主导,实际 ${r.eCycle}`);
});

test("qualitative 被跳过,不进 E_cycle", () => {
  const claims: Claim[] = [
    { id: "m", type: "metric_threshold", operator: ">=", target: 1, observed: 1, scale: 1, weight: 1 },
    { id: "q", type: "qualitative", weight: 5 },
  ];
  const r = computeCycleError(claims);
  assert.equal(r.skippedClaims, 1);
  assert.equal(r.scoredClaims, 1);
});
