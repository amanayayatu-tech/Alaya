/**
 * classify_error —— PRD 10.6 误差归因决策树
 *
 * 必须按固定顺序判定:
 * 1. 数据源问题 => perception
 * 2. 关联 task build 失败 => execution
 * 3. 指标达标但人类标记方向不对 => value
 * 4. 以上都不成立且误差超阈值 => model
 * 5. qualitative 不自动归因 => 返回 null,进意义闸
 */

import type { AttributionContext, ErrorType } from "./types.js";

export const MODEL_ERROR_THRESHOLD = 0.5;
export const MODEL_ERROR_THRESHOLD_BOUNDARY_MARGIN = 0.1;
export const ATTRIBUTION_MULTI_SIGNAL_PENALTY = 0.2;
export const ATTRIBUTION_THRESHOLD_BOUNDARY_PENALTY = 0.15;

export interface ErrorAttributionWithConfidence {
  errorType: ErrorType;
  route: string;
  attributionConfidence: number;
  lowConfidenceReasons: string[];
}

export function classifyError(
  claimError: number | null,
  ctx: AttributionContext,
): ErrorType {
  // 5. qualitative 不进入自动归因
  if (ctx.isQualitative) return null;

  // 1. 感知误差优先
  if (ctx.perceptionFailure) return "perception";

  // 2. 执行误差
  if (ctx.executionFailure) return "execution";

  // 3. 价值误差:指标达标(误差低)但人类标记方向不对/违背 identity
  if (ctx.humanFlaggedValueMismatch) return "value";

  // 4. 误差超阈值才归为模型误差;否则视为预测基本成立,无显著误差
  if (claimError != null && claimError > MODEL_ERROR_THRESHOLD) return "model";

  return null;
}

export function classifyErrorWithConfidence(
  claimError: number | null,
  ctx: AttributionContext,
): ErrorAttributionWithConfidence {
  const errorType = classifyError(claimError, ctx);
  const lowConfidenceReasons: string[] = [];
  let attributionConfidence = 1;

  const attributionSignalCount = [
    ctx.perceptionFailure,
    ctx.executionFailure,
    ctx.humanFlaggedValueMismatch,
  ].filter(Boolean).length;
  if (attributionSignalCount > 1) {
    attributionConfidence -= (attributionSignalCount - 1) * ATTRIBUTION_MULTI_SIGNAL_PENALTY;
    lowConfidenceReasons.push("multiple_attribution_signals");
  }

  if (claimError != null && Number.isFinite(claimError)) {
    const distanceFromThreshold = Math.round(Math.abs(claimError - MODEL_ERROR_THRESHOLD) * 1e12) / 1e12;
    if (distanceFromThreshold < MODEL_ERROR_THRESHOLD_BOUNDARY_MARGIN) {
      attributionConfidence -= ATTRIBUTION_THRESHOLD_BOUNDARY_PENALTY;
      lowConfidenceReasons.push("near_model_error_threshold");
    }
  }

  return {
    errorType,
    route: routeError(errorType),
    attributionConfidence: Math.max(0, Math.min(1, Number(attributionConfidence.toFixed(6)))),
    lowConfidenceReasons,
  };
}

/**
 * 误差处理路由 (PRD 10.3):决定该误差进入哪个后续动作。
 */
export function routeError(errorType: ErrorType): string {
  switch (errorType) {
    case "perception":
      return "update_data_source"; // 更新数据源、采集方式、反馈 schema
    case "execution":
      return "builder_fix_queue"; // 进 Builder 修复队列
    case "model":
      return "distiller_world_model_update"; // 进 Distiller / world_model 更新
    case "value":
      return "human_meaning_or_direction_gate"; // 必须进人类意义闸或方向闸
    default:
      return "no_action_or_meaning_gate";
  }
}
