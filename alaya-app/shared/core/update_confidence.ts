/**
 * update_confidence —— PRD 8.6 置信度计算
 *
 * 禁止使用 LLM 自报置信度。confidence_score 由证据计数 (Beta 分布均值) 计算。
 *
 * 修复漏洞D:evidenceCount 统一口径 = (alpha-1)+(beta-1),剔除先验。
 * 修复漏洞E:灰区(0.3<e<0.7)不再完全丢弃。
 *   - e ∈ [0.3,0.5) 视为弱支持 alpha += 0.5
 *   - e ∈ [0.5,0.7) 视为弱反对 beta += 0.5
 *   并记录连续灰区计数,达到阈值触发意义闸(由上层 Agent 读取)。
 *   人类批准/外部验证仍是灰区指标晋级的主通道。
 */

import type { KnowledgeItem, ConfidenceLevel } from "./types.js";
import { evidenceCount } from "./types.js";

export const GRAY_LOW = 0.3;
export const GRAY_HIGH = 0.7;
export const GRAY_STREAK_TO_GATE = 3; // 连续灰区达此次数,建议升意义闸

export type EvidenceEvent =
  | { kind: "prediction"; normalizedError: number }
  | { kind: "human_approve" }
  | { kind: "human_reject" }
  | { kind: "external_verify" };

export interface ConfidenceUpdateResult {
  next: KnowledgeItem;
  /** 本次是否落入灰区(用于上层累计连续灰区) */
  grayZone: boolean;
  /** 是否建议触发意义闸(连续灰区超阈值) */
  suggestMeaningGate: boolean;
}

function computeLevel(score: number, evCount: number, humanApproved: boolean): ConfidenceLevel {
  // 修复漏洞D:统一用剔除先验后的 evidenceCount
  if (score >= 0.85 && evCount >= 5 && humanApproved) return "verified";
  if (score >= 0.75 && evCount >= 3) return "high";
  if (score >= 0.6 && evCount >= 1) return "medium";
  return "low";
}

export function applyEvidence(
  k: KnowledgeItem,
  event: EvidenceEvent,
  grayStreakBefore = 0,
): ConfidenceUpdateResult {
  let { evidenceAlpha: alpha, evidenceBeta: beta } = k;
  let humanApprovedCount = k.humanApprovedCount;
  let externalVerifiedCount = k.externalVerifiedCount;
  let grayZone = false;
  let grayStreak = grayStreakBefore;

  switch (event.kind) {
    case "prediction": {
      const e = event.normalizedError;
      if (e <= GRAY_LOW) {
        alpha += 1; // 预测命中,强支持
        grayStreak = 0;
      } else if (e >= GRAY_HIGH) {
        beta += 1; // 预测失败,强反对
        grayStreak = 0;
      } else {
        // 修复漏洞E:灰区弱累加,不再丢弃
        grayZone = true;
        grayStreak += 1;
        if (e < 0.5) alpha += 0.5;
        else beta += 0.5;
      }
      break;
    }
    case "human_approve":
      alpha += 3; // PRD 8.6:人类批准是主通道
      humanApprovedCount += 1;
      grayStreak = 0;
      break;
    case "human_reject":
      beta += 3;
      grayStreak = 0;
      break;
    case "external_verify":
      alpha += 2; // 独立外部来源
      externalVerifiedCount += 1;
      grayStreak = 0;
      break;
  }

  const score = alpha / (alpha + beta);
  const next: KnowledgeItem = {
    ...k,
    evidenceAlpha: alpha,
    evidenceBeta: beta,
    confidenceScore: score,
    humanApprovedCount,
    externalVerifiedCount,
    confidenceLevel: computeLevel(score, evidenceCount({ evidenceAlpha: alpha, evidenceBeta: beta }), humanApprovedCount > 0),
  };

  return {
    next,
    grayZone,
    suggestMeaningGate: grayStreak >= GRAY_STREAK_TO_GATE,
  };
}

export interface TimeDecayInput {
  score: number;
  lastVerifiedAt: number;
  storageStrength?: number | null;
}

export interface TimeDecayResult {
  newScore: number;
  newStorageStrength: number;
  shouldDemoteToStale: boolean;
  daysSinceLastVerified: number;
}

/**
 * Bjork 双强度时间衰减。
 * retrieval strength(score) 衰减较快,storage strength 衰减较慢。
 */
export function applyTimeDecay(
  knowledge: TimeDecayInput,
  currentTime: number,
  lambda = 0.03,
): TimeDecayResult {
  const daysSinceLastVerified = Math.max(0, (currentTime - knowledge.lastVerifiedAt) / 86_400_000);
  const safeLambda = Number.isFinite(lambda) && lambda >= 0 ? lambda : 0.03;
  const currentStorage = knowledge.storageStrength ?? 1;
  const newScore = knowledge.score * Math.exp(-safeLambda * daysSinceLastVerified);
  const newStorageStrength = currentStorage * Math.exp(-(safeLambda / 4) * daysSinceLastVerified);
  return {
    newScore,
    newStorageStrength,
    shouldDemoteToStale: newScore < 0.5,
    daysSinceLastVerified,
  };
}

/**
 * 知识衰减 —— 修复漏洞F:定义显式衰减,按 cycle 触发。
 * score_decayed = score * exp(-λ * cyclesSinceValidated)
 */
export const DECAY_LAMBDA = 0.15;

export function decayConfidence(k: KnowledgeItem, currentCycle: number): KnowledgeItem {
  const gap = Math.max(0, currentCycle - k.lastValidatedCycle);
  if (gap === 0) return k;
  const decayed = k.confidenceScore * Math.exp(-DECAY_LAMBDA * gap);
  return {
    ...k,
    confidenceScore: decayed,
    confidenceLevel: computeLevel(
      decayed,
      evidenceCount(k),
      k.humanApprovedCount > 0,
    ),
  };
}
