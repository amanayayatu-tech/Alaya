/**
 * One-click demo seed: a "一键发布" product project run through 3 flywheel turns,
 * reusing the deterministic scenario. Opening the app shows knowledge K1/K2,
 * prediction errors, promotion to strong, and gate records.
 */
import { storage } from "./storage";
import { createProjectFromOnboarding } from "./onboarding";
import { runFullCycle, SCENARIO } from "./flywheel";

export const DEMO_NAME = "一键发布演示项目";

export function demoExists(): boolean {
  return storage.listProjects().some((p) => p.name === DEMO_NAME);
}

export async function seedDemo(): Promise<{ projectId: string }> {
  // idempotent: if exists, return it
  const existing = storage.listProjects().find((p) => p.name === DEMO_NAME);
  if (existing) return { projectId: existing.id };

  const project = await createProjectFromOnboarding({
    name: DEMO_NAME,
    oneLiner: "让创作者一键把作品发布到所有渠道",
    targetUser: "独立创作者与小团队",
    currentHypothesis: "早期用户最关心快速发布,而不是高级定制",
    neverDo: "未经确认就执行不可逆操作",
    redlines: ["不得在无预览的情况下删除用户数据", "不得自动发布到未授权渠道"],
    founderPreference: "克制、安全优先、尊重用户控制权",
    competitors: "Buffer、Hootsuite",
    feedbackSources: "应用内反馈、用户访谈",
    weeklyHumanMinutes: 150,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    firstSignal: "activation_rate(尝试一键发布的活跃用户比例)",
  });

  const projectId = project.id;

  // cycle 1 already exists from onboarding (idx=1). Run it, then create + run 2 & 3.
  const cycles = storage.listCycles(projectId);
  const c1 = cycles.find((c) => c.idx === 1)!;
  await runFullCycle(projectId, c1.id);

  for (let idx = 2; idx <= SCENARIO.length; idx++) {
    const sc = SCENARIO.find((s) => s.index === idx)!;
    const cyc = storage.createCycle({
      id: `cycle_${idx}_${projectId.slice(-4)}`, projectId, idx,
      goal: sc.proposedGoal, status: "planning", eCycle: null, worstClaimError: null,
      reasoning: "", version: 1,
    });
    storage.updateProject(projectId, { currentCycleIdx: idx });
    await runFullCycle(projectId, cyc.id);
  }

  return { projectId };
}
