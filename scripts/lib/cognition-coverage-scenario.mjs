import { oracleMetadataForSide } from "./health-signal-quality.mjs";

const SIDE = "tiered_support";

const COGNITION_COVERAGE_CASES = Object.freeze([
  {
    factor: "订单恢复与毛利率弹性",
    evidence: "订单恢复、毛利率弹性和现金流改善共同支持保留核心多头。",
    hedge: "空头或现金对冲覆盖财报波动与估值回撤。",
    confidence: 0.82,
  },
  {
    factor: "估值修复与事件风险",
    evidence: "估值修复空间仍在，但事件催化前后的波动需要风险预算约束。",
    hedge: "对冲腿用于限制单边高杠杆暴露。",
    confidence: 0.84,
  },
  {
    factor: "收入指引与回撤预算",
    evidence: "收入指引改善支持多头假设，组合最大回撤预算限制裸露仓位。",
    hedge: "现金保护降低财报窗口外溢风险。",
    confidence: 0.83,
  },
  {
    factor: "自由现金流与对冲成本",
    evidence: "自由现金流修复提升上行弹性，对冲成本仍可由仓位分层吸收。",
    hedge: "分层仓位比单边多头更符合风险预算。",
    confidence: 0.85,
  },
  {
    factor: "利润率修复与空头拥挤",
    evidence: "利润率修复和空头拥挤同时存在，单边方向信号不足。",
    hedge: "核心多头配合空头对冲能保留上行并控制回补风险。",
    confidence: 0.81,
  },
  {
    factor: "基本面上修与流动性约束",
    evidence: "基本面上修提高多头胜率，流动性约束要求仓位保持可退出。",
    hedge: "现金腿为突发回撤提供再平衡空间。",
    confidence: 0.86,
  },
]);

export function cognitionCoverageExternalId(ordinal) {
  const n = Math.max(1, Math.trunc(Number(ordinal) || 1));
  return `sample_${String(n).padStart(4, "0")}_${SIDE}`;
}

export function buildCognitionCoverageEvidence(ordinal) {
  const n = Math.max(1, Math.trunc(Number(ordinal) || 1));
  const item = COGNITION_COVERAGE_CASES[(n - 1) % COGNITION_COVERAGE_CASES.length];
  const variant = Math.floor((n - 1) / COGNITION_COVERAGE_CASES.length) + 1;
  const externalId = cognitionCoverageExternalId(n);
  const confidence = +(item.confidence - Math.min(variant - 1, 4) * 0.01).toFixed(2);
  const title = `Phase2 校准样本 ${String(n).padStart(3, "0")}：${item.factor}`;
  const text = [
    `Phase2 校准样本 ${String(n).padStart(3, "0")}：${item.evidence}`,
    "tiered_thesis_confidence >= 0.81。",
    `当前最优仓位决策：多空分层仓位方案，置信度 ${confidence.toFixed(2)}。`,
    `关键依据：${item.hedge}`,
  ].join("\n");
  return {
    side: SIDE,
    sourceName: "equity-thesis-contradiction-runner",
    externalId,
    title,
    text,
    ...oracleMetadataForSide(SIDE),
  };
}

