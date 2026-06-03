/**
 * 确定性 3 轮飞轮场景 (PRD 17.3)。
 * 设计目标:让第 3 轮能真实复用前两轮知识并改变决策,而非形式引用。
 *
 * 叙事:一个"一键发布"产品的冷启动。
 * - 第1轮:假设"早期用户最关心快速发布",上线一键发布。预测 activation>=0.3。
 *   现实:activation 只有 0.12(预测失败)。Sensor 收到反馈"发布前不知道会改动什么,不敢点"。
 *   => 提炼知识 K1:用户对"不可预期的自动操作"有恐惧,需要 dry-run 预览。
 * - 第2轮:基于 K1,改做"发布预览 + 确认"。预测 activation>=0.3。
 *   现实:activation 升到 0.34(达标)。反馈"预览让我敢用了"。K1 获得支持证据。
 *   => 提炼知识 K2:可逆/可预览显著降低高风险动作的使用门槛。
 * - 第3轮:Orchestrator 生成新目标时,必须引用 K1+K2,主动避开"再加一个自动化但不可预览"的方向,
 *   转而提出"为删除操作也加预览"。这就是复利:决策被前两轮知识改变。
 */

export interface FeedbackItem {
  id: string;
  text: string; // 用户原话(PRD 9.1 要求保留原文)
  category: "bug" | "feature_request" | "unclear_signal" | "metric_signal";
  sentiment: "positive" | "negative" | "neutral";
}

export interface CycleScenario {
  index: number;
  proposedGoal: string;
  alternativeGoals: string[];
  belief: string;
  prediction: string;
  action: string;
  /** 本轮 metric_threshold 观察值 */
  activationObserved: number;
  activationTarget: number;
  /** 本轮反馈 */
  feedback: FeedbackItem[];
  /** build 是否成功 */
  buildSuccess: boolean;
  /** 数据源是否正常 */
  perceptionOk: boolean;
  /** 人类是否标记价值不对 */
  humanValueMismatch: boolean;
}

export const SCENARIO: CycleScenario[] = [
  {
    index: 1,
    proposedGoal: "上线一键发布,验证早期用户是否愿意快速发布",
    alternativeGoals: ["先做高级定制能力", "先做团队协作"],
    belief: "早期用户最关心快速发布,而不是高级定制",
    prediction: "上线一键发布后,至少 30% 活跃测试用户会尝试",
    action: "开发一键发布 MVP",
    activationObserved: 0.12,
    activationTarget: 0.3,
    feedback: [
      { id: "f1", text: "我不敢点发布,因为不知道它到底会改动什么", category: "unclear_signal", sentiment: "negative" },
      { id: "f2", text: "一键发布听起来很爽但有点怕翻车", category: "feature_request", sentiment: "negative" },
    ],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  },
  {
    index: 2,
    proposedGoal: "为发布加上 dry-run 预览与确认,降低用户恐惧",
    alternativeGoals: ["直接推广一键发布", "加更多发布渠道"],
    belief: "用户对不可预期的自动操作有恐惧,需要可预览",
    prediction: "加上发布预览后,activation 升到 30% 以上",
    action: "开发发布预览 + 确认步骤",
    activationObserved: 0.34,
    activationTarget: 0.3,
    feedback: [
      { id: "f3", text: "现在能先看到会发什么,我就敢用了", category: "metric_signal", sentiment: "positive" },
      { id: "f4", text: "预览很关键,删东西的时候也想要这个", category: "feature_request", sentiment: "positive" },
    ],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  },
  {
    index: 3,
    // 第3轮目标由 Orchestrator 基于 K1+K2 动态生成,这里只给反馈与观察。
    proposedGoal: "(由系统基于前轮知识生成)",
    alternativeGoals: [],
    belief: "(由系统生成)",
    prediction: "(由系统生成)",
    action: "(由系统生成)",
    activationObserved: 0.41,
    activationTarget: 0.3,
    feedback: [
      { id: "f5", text: "删除前的预览太贴心了,这正是我担心的", category: "metric_signal", sentiment: "positive" },
    ],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  },
];
