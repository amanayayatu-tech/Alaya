import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvidence, decayConfidence } from "../src/core/update_confidence.js";
import { transitionState, eligibleForHighRisk } from "../src/core/transition_state.js";
import { evidenceCount } from "../src/core/types.js";
import type { KnowledgeItem } from "../src/core/types.js";

function seed(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "kb_1",
    projectId: "p1",
    type: "principle",
    title: "t",
    content: "c",
    sourceType: "agent_observation",
    sourceRef: "ref",
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "draft",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-03",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: [],
    notes: "",
    ...overrides,
  };
}

// ---- 漏洞D:evidenceCount 口径自洽 ----
test("漏洞D:evidenceCount = (alpha-1)+(beta-1)", () => {
  assert.equal(evidenceCount({ evidenceAlpha: 1, evidenceBeta: 1 }), 0); // 初始
  assert.equal(evidenceCount({ evidenceAlpha: 2, evidenceBeta: 1 }), 1); // PRD示例自洽
  assert.equal(evidenceCount({ evidenceAlpha: 4, evidenceBeta: 1 }), 3);
});

test("初始知识为 low,score=0.5,evidenceCount=0", () => {
  const k = seed();
  assert.equal(k.confidenceLevel, "low");
  assert.equal(evidenceCount(k), 0);
});

test("预测命中 alpha+1,score 上升", () => {
  const k = seed();
  const r = applyEvidence(k, { kind: "prediction", normalizedError: 0.1 });
  assert.equal(r.next.evidenceAlpha, 2);
  assert.ok(r.next.confidenceScore > 0.6);
  assert.equal(r.grayZone, false);
});

test("预测失败 beta+1", () => {
  const k = seed();
  const r = applyEvidence(k, { kind: "prediction", normalizedError: 0.9 });
  assert.equal(r.next.evidenceBeta, 2);
  assert.ok(r.next.confidenceScore < 0.5);
});

// ---- 漏洞E:灰区不再死锁 ----
test("漏洞E:灰区弱累加而非完全丢弃", () => {
  const k = seed();
  // e=0.4 落在 [0.3,0.5) => alpha+=0.5
  const r1 = applyEvidence(k, { kind: "prediction", normalizedError: 0.4 });
  assert.equal(r1.next.evidenceAlpha, 1.5, "灰区下半应弱支持");
  assert.equal(r1.grayZone, true);
  // e=0.6 落在 [0.5,0.7) => beta+=0.5
  const r2 = applyEvidence(k, { kind: "prediction", normalizedError: 0.6 });
  assert.equal(r2.next.evidenceBeta, 1.5, "灰区上半应弱反对");
});

test("漏洞E:连续灰区触发意义闸建议", () => {
  const k = seed();
  let streak = 0;
  let res = applyEvidence(k, { kind: "prediction", normalizedError: 0.45 }, streak);
  streak = res.grayZone ? streak + 1 : 0;
  res = applyEvidence(res.next, { kind: "prediction", normalizedError: 0.45 }, streak);
  streak = res.grayZone ? streak + 1 : 0;
  res = applyEvidence(res.next, { kind: "prediction", normalizedError: 0.45 }, streak);
  assert.equal(res.suggestMeaningGate, true, "连续3次灰区应建议升意义闸");
});

test("人类批准 alpha+=3,是灰区指标主晋级通道", () => {
  const k = seed();
  const r = applyEvidence(k, { kind: "human_approve" });
  assert.equal(r.next.evidenceAlpha, 4);
  assert.equal(r.next.humanApprovedCount, 1);
  assert.equal(r.next.confidenceScore, 0.8);
});

// ---- 漏洞F:衰减函数 ----
test("漏洞F:衰减按 cycle 触发,score 随间隔下降", () => {
  const k = seed({ confidenceScore: 0.9, lastValidatedCycle: 1 });
  const decayed = decayConfidence(k, 5); // gap=4
  assert.ok(decayed.confidenceScore < 0.9);
  assert.ok(decayed.confidenceScore > 0);
});

test("衰减 gap=0 时不变", () => {
  const k = seed({ confidenceScore: 0.9, lastValidatedCycle: 5 });
  assert.equal(decayConfidence(k, 5).confidenceScore, 0.9);
});

// ---- 状态迁移 ----
test("draft->active 需 score>=0.6 且 evidenceCount>=1", () => {
  const k = seed({ evidenceAlpha: 2, evidenceBeta: 1, confidenceScore: 2 / 3 });
  const r = transitionState(k, { currentCycle: 2, conflictsWithStrong: false });
  assert.equal(r.nextStatus, "active");
  assert.equal(r.changed, true);
});

test("active->strong 需人类确认(两步)", () => {
  const k = seed({ status: "active", evidenceAlpha: 8, evidenceBeta: 1, confidenceScore: 8 / 9, humanApprovedCount: 1 });
  // 第一步:满足数值条件但未确认 => requiresHuman,不迁移
  const r1 = transitionState(k, { currentCycle: 5, conflictsWithStrong: false });
  assert.equal(r1.requiresHuman, true);
  assert.equal(r1.changed, false);
  // 第二步:人类确认后才迁移
  const r2 = transitionState(k, { currentCycle: 5, conflictsWithStrong: false, humanApprovedStrongPromotion: true });
  assert.equal(r2.nextStatus, "strong");
  assert.equal(r2.changed, true);
});

test("任意->conflict:与strong断言相反", () => {
  const k = seed({ status: "active" });
  const r = transitionState(k, { currentCycle: 3, conflictsWithStrong: true });
  assert.equal(r.nextStatus, "conflict");
});

test("任意->quarantined:evidenceCount>=3且score<0.35", () => {
  const k = seed({ status: "active", evidenceAlpha: 1, evidenceBeta: 5, confidenceScore: 1 / 6 });
  const r = transitionState(k, { currentCycle: 4, conflictsWithStrong: false });
  assert.equal(r.nextStatus, "quarantined");
});

test("stale->expired 超保留期", () => {
  const k = seed({ status: "stale", confidenceScore: 0.4 });
  const r = transitionState(k, { currentCycle: 10, conflictsWithStrong: false, cyclesInStale: 3 });
  assert.equal(r.nextStatus, "expired");
});

test("硬约束:stale/expired/quarantined/conflict 不进高风险证据集", () => {
  assert.equal(eligibleForHighRisk(seed({ status: "strong" })), true);
  assert.equal(eligibleForHighRisk(seed({ status: "active" })), true);
  assert.equal(eligibleForHighRisk(seed({ status: "stale" })), false);
  assert.equal(eligibleForHighRisk(seed({ status: "expired" })), false);
  assert.equal(eligibleForHighRisk(seed({ status: "quarantined" })), false);
  assert.equal(eligibleForHighRisk(seed({ status: "conflict" })), false);
});
