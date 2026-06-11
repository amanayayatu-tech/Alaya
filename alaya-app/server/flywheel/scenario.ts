import type { Operator } from "alaya-core/src/core/types.js";

export interface ScenarioRound {
  index: number;
  proposedGoal: string;
  alternativeGoals: string[];
  belief: string;
  prediction: string;
  action: string;
  activationObserved: number;
  activationTarget: number;
  feedback: { id: string; text: string; category: string; sentiment: string }[];
  buildSuccess: boolean;
  perceptionOk: boolean;
  humanValueMismatch: boolean;
  predictionMetric?: string;
  predictionOperator?: Operator;
  predictionTarget?: number;
  knowledgeRefs?: string[];
  reasoningHowKnowledgeChangedDecision?: string;
}

export const SCENARIO: ScenarioRound[] = [
  {
    index: 1,
    proposedGoal: "上线一键发布,验证早期用户是否愿意快速发布",
    alternativeGoals: ["先做高级定制能力", "先做团队协作"],
    belief: "早期用户最关心快速发布,而不是高级定制",
    prediction: "上线一键发布后,至少 30% 活跃测试用户会尝试",
    action: "开发一键发布 MVP",
    activationObserved: 0.12, activationTarget: 0.3,
    feedback: [
      { id: "f1", text: "我不敢点发布,因为不知道它到底会改动什么", category: "unclear_signal", sentiment: "negative" },
      { id: "f2", text: "一键发布听起来很爽但有点怕翻车", category: "feature_request", sentiment: "negative" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 2,
    proposedGoal: "为发布加上 dry-run 预览与确认,降低用户恐惧",
    alternativeGoals: ["直接推广一键发布", "加更多发布渠道"],
    belief: "用户对不可预期的自动操作有恐惧,需要可预览",
    prediction: "加上发布预览后,activation 升到 30% 以上",
    action: "开发发布预览 + 确认步骤",
    activationObserved: 0.34, activationTarget: 0.3,
    feedback: [
      { id: "f3", text: "现在能先看到会发什么,我就敢用了", category: "metric_signal", sentiment: "positive" },
      { id: "f4", text: "预览很关键,删东西的时候也想要这个", category: "feature_request", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 3,
    proposedGoal: "(由系统基于前轮知识生成)",
    alternativeGoals: [],
    belief: "(由系统生成)",
    prediction: "(由系统生成)",
    action: "(由系统生成)",
    activationObserved: 0.41, activationTarget: 0.3,
    feedback: [
      { id: "f5", text: "删除前的预览太贴心了,这正是我担心的", category: "metric_signal", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
  {
    index: 4,
    proposedGoal: "(由系统基于 strong/active 知识继续生成)",
    alternativeGoals: ["直接开放批量删除", "先做视觉主题与模板"],
    belief: "高风险自动化要继续扩大适用范围,必须同时满足可预览、可回滚、可追溯",
    prediction: "加入回滚与审计摘要后,activation 达到 45% 以上且正向复盘反馈增加",
    action: "开发变更包回滚入口 + 自动审计摘要",
    activationObserved: 0.48, activationTarget: 0.45,
    feedback: [
      { id: "f6", text: "现在有预览和回滚记录,我愿意让它处理更多发布前检查", category: "metric_signal", sentiment: "positive" },
      { id: "f7", text: "如果每次自动操作都有审计摘要,我可以拿给同事复盘", category: "feature_request", sentiment: "positive" },
    ],
    buildSuccess: true, perceptionOk: true, humanValueMismatch: false,
  },
];

export function scenarioForCycle(index: number): ScenarioRound | undefined {
  return SCENARIO.find((s) => s.index === index);
}
