/**
 * transition_knowledge_state —— PRD 8.6 状态迁移
 *
 * | 迁移 | 触发条件 | 是否需人类 |
 * | draft/candidate -> active | score>=0.6 且 evidenceCount>=1 | 否 |
 * | active -> strong | score>=0.85 且 evidenceCount>=5 且 >=1 次人类批准 | 是 |
 * | active -> stale | 超有效期未验证,或衰减后 score<0.5 | 否 |
 * | 任意 -> conflict | 与现有 strong 知识断言相反且证据相当 | 否,自动标记 |
 * | 任意 -> quarantined | evidenceCount>=3 且 score<0.35 | 否 |
 * | stale -> expired | stale 超保留期且无新证据 | 否 |
 * | active/strong -> deprecated | 被更具体原则替代时由 Librarian 通过 supersededBy 标记 | 否 |
 * | any -> rejected | 被 benchmark 或人工复盘证明有害 | 是 |
 *
 * 硬约束:stale/expired/quarantined/conflict 不得进入高风险动作证据集。
 */

import type { KnowledgeItem, KnowledgeStatus } from "./types.js";
import { evidenceCount } from "./types.js";

export const STALE_DECAY_SCORE = 0.5;
export const QUARANTINE_SCORE = 0.35;
export const STRONG_SCORE = 0.85;
export const ACTIVE_SCORE = 0.6;
export const EXPIRE_AFTER_STALE_CYCLES = 3;

export interface TransitionContext {
  currentCycle: number;
  /** 与某条 strong 知识断言相反且证据相当 */
  conflictsWithStrong: boolean;
  /** 该知识已停留 stale 多少个 cycle */
  cyclesInStale?: number;
  /** 最近使用距今的天数,用于灰区墙钟衰减审计 */
  daysSinceLastUse?: number;
  /** 灰区墙钟通道给出的计算视图分数 */
  wallclockDecayedScore?: number;
  /** 有效期已过,需要通过状态机降级,避免上层直接改状态 */
  validUntilExpired?: boolean;
  /** active->strong 是否已获得人类批准(此迁移需人类闸) */
  humanApprovedStrongPromotion?: boolean;
}

export interface TransitionResult {
  nextStatus: KnowledgeStatus;
  changed: boolean;
  requiresHuman: boolean;
  reason: string;
}

export function transitionState(
  k: KnowledgeItem,
  ctx: TransitionContext,
): TransitionResult {
  const ev = evidenceCount(k);
  const score = k.confidenceScore;
  const wallclockScore = typeof ctx.wallclockDecayedScore === "number" && Number.isFinite(ctx.wallclockDecayedScore)
    ? ctx.wallclockDecayedScore
    : score;
  const effectiveScore = Math.min(score, wallclockScore);
  const cur = k.status;
  const keep = (reason: string): TransitionResult => ({
    nextStatus: cur,
    changed: false,
    requiresHuman: false,
    reason,
  });

  // 冲突优先:任意 -> conflict (自动标记,不直接覆盖)
  if (ctx.conflictsWithStrong && cur !== "conflict") {
    return { nextStatus: "conflict", changed: true, requiresHuman: false, reason: "与 strong 知识断言相反且证据相当" };
  }

  if (
    ctx.validUntilExpired &&
    !["stale", "expired", "quarantined", "conflict", "deprecated", "rejected"].includes(cur)
  ) {
    return { nextStatus: "stale", changed: true, requiresHuman: false, reason: "valid_until expired" };
  }

  // 隔离:任意 -> quarantined
  if (ev >= 3 && score < QUARANTINE_SCORE && cur !== "quarantined") {
    return { nextStatus: "quarantined", changed: true, requiresHuman: false, reason: `evidenceCount=${ev} 且 score=${score.toFixed(2)}<0.35` };
  }

  switch (cur) {
    case "candidate":
    case "draft":
    case "provisional": {
      if (score >= ACTIVE_SCORE && ev >= 1) {
        return { nextStatus: "active", changed: true, requiresHuman: false, reason: "score>=0.6 且 evidenceCount>=1" };
      }
      return keep("证据不足以晋级 active");
    }
    case "active": {
      // 衰减导致 score<0.5 -> stale
      if (effectiveScore < STALE_DECAY_SCORE) {
        const channel = wallclockScore < score ? "wallclock_decay" : "cycle_decay";
        const days = typeof ctx.daysSinceLastUse === "number" ? `,daysSinceLastUse=${ctx.daysSinceLastUse.toFixed(1)}` : "";
        return { nextStatus: "stale", changed: true, requiresHuman: false, reason: `${channel} effectiveScore=${effectiveScore.toFixed(2)}<0.5${days}` };
      }
      // 晋级 strong 需人类批准(此迁移需人类闸)
      if (score >= STRONG_SCORE && ev >= 5 && k.humanApprovedCount >= 1) {
        if (!ctx.humanApprovedStrongPromotion) {
          return { nextStatus: "active", changed: false, requiresHuman: true, reason: "满足 strong 数值条件,等待人类确认晋级" };
        }
        return { nextStatus: "strong", changed: true, requiresHuman: true, reason: "score>=0.85,evidenceCount>=5,人类已批准" };
      }
      return keep("维持 active");
    }
    case "stale": {
      if ((ctx.cyclesInStale ?? 0) >= EXPIRE_AFTER_STALE_CYCLES) {
        return { nextStatus: "expired", changed: true, requiresHuman: false, reason: "stale 超保留期且无新证据" };
      }
      // 重新获得证据可回到 active
      if (score >= ACTIVE_SCORE && ev >= 1) {
        return { nextStatus: "active", changed: true, requiresHuman: false, reason: "重新积累证据,回到 active" };
      }
      return keep("维持 stale");
    }
    case "strong": {
      if (score < STALE_DECAY_SCORE) {
        return { nextStatus: "stale", changed: true, requiresHuman: false, reason: "strong 知识衰减,降级 stale" };
      }
      return keep("维持 strong");
    }
    case "deprecated":
    case "rejected": {
      return keep(`${cur} 知识不自动重新进入决策集`);
    }
    default:
      return keep(`状态 ${cur} 无自动迁移`);
  }
}

/** 硬约束:该知识能否进入高风险动作证据集 (PRD 8.6 末尾) */
export function eligibleForHighRisk(k: KnowledgeItem): boolean {
  return !["stale", "expired", "quarantined", "conflict", "deprecated", "rejected"].includes(k.status);
}
