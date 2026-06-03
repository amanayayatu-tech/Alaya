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
