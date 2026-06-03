/**
 * compute_error / E_cycle —— PRD 10.5
 *
 * 修复漏洞A:由 operator 推导方向因子 d,正确处理"越小越好"指标。
 * 修复漏洞B:scale 强制正下限,杜绝 T=0 除零。
 * 修复漏洞C:E_cycle 同时返回 worstClaimError,惩罚大错不被稀释。
 * 修复漏洞G:binary/categorical/directional 也产出离散误差并纳入 E_cycle。
 */

import type { Claim } from "./types.js";

const EPS = 1e-6;

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 单个 metric_threshold claim 的归一化误差 e ∈ [0,1]。
 * 达标或超额完成 => 0;差距越大 => 越接近 1。
 */
export function computeMetricError(
  target: number,
  observed: number,
  operator: ">=" | "<=" | "==",
  scale?: number,
): number {
  // 修复漏洞B:scale 必须为正,默认取 |target| 但有正下限
  const s = Math.max(scale ?? Math.abs(target), EPS);

  // 修复漏洞A:方向因子由 operator 推导
  // ">=":越大越好,达标方向 d=+1,未达标时 target>observed
  // "<=":越小越好,达标方向 d=-1,未达标时 observed>target
  // "==":双向偏离都算误差
  if (operator === "==") {
    return clip(Math.abs(target - observed) / s, 0, 1);
  }
  const d = operator === ">=" ? +1 : -1;
  return clip(Math.max(0, d * (target - observed)) / s, 0, 1);
}

/** 计算单个 claim 的误差。不可计算(qualitative)返回 null。 */
export function computeClaimError(claim: Claim): number | null {
  switch (claim.type) {
    case "metric_threshold": {
      if (
        claim.target == null ||
        claim.observed == null ||
        claim.operator == null
      ) {
        return null;
      }
      return computeMetricError(
        claim.target,
        claim.observed,
        claim.operator,
        claim.scale,
      );
    }
    case "binary": {
      // 命中 0,未命中 1
      if (claim.actual == null) return null;
      return claim.actual === claim.expected ? 0 : 1;
    }
    case "categorical": {
      if (claim.actual == null) return null;
      return claim.actual === claim.expected ? 0 : 1;
    }
    case "directional": {
      // 方向对 0,反向 1,持平 0.5 (PRD 10.4)
      if (claim.actualDirection == null) return null;
      if (claim.actualDirection === claim.expectedDirection) return 0;
      if (claim.actualDirection === "flat") return 0.5;
      return 1;
    }
    case "qualitative":
      // 不自动计算,进意义闸 (PRD 10.4)
      return null;
    default:
      return null;
  }
}

export interface CycleErrorResult {
  /** 加权平方平均 (PRD 10.5) */
  eCycle: number | null;
  /** 修复漏洞C:最差单 claim 误差,供失败阈值判定,不被稀释 */
  worstClaimError: number | null;
  /** 参与计算的 claim 数 */
  scoredClaims: number;
  /** 因 qualitative/数据缺失而跳过的 claim 数 */
  skippedClaims: number;
}

/**
 * 整轮预测误差。
 * E_cycle = sum(w_i * e_i^2) / sum(w_i)
 * 修复漏洞C:平方加权在权重相同时会稀释大错,因此额外返回 worstClaimError,
 *   并建议关键 metric_threshold claim 的 weight>=3。失败阈值判定应同时看二者。
 * 修复漏洞G:所有可计算 claim 类型(含 binary/categorical/directional)均纳入。
 */
export function computeCycleError(claims: Claim[]): CycleErrorResult {
  let num = 0;
  let den = 0;
  let worst: number | null = null;
  let scored = 0;
  let skipped = 0;

  for (const c of claims) {
    const e = computeClaimError(c);
    if (e == null) {
      skipped++;
      continue;
    }
    scored++;
    const w = c.weight ?? 1;
    num += w * e * e;
    den += w;
    if (worst == null || e > worst) worst = e;
  }

  return {
    eCycle: den > 0 ? num / den : null,
    worstClaimError: worst,
    scoredClaims: scored,
    skippedClaims: skipped,
  };
}
