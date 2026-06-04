export type Tone = "default" | "primary" | "success" | "warning" | "danger" | "muted";

export type LabelMeta = {
  label: string;
  short?: string;
  description?: string;
  tone?: Tone;
};

export const flywheelStageLabels: Record<string, LabelMeta> = {
  idle: { label: "等待下一步", short: "等待", description: "当前没有正在运行的 Agent。", tone: "muted" },
  orchestrator: { label: "判断方向", short: "方向", description: "选择本轮目标，引用历史知识并打开方向闸。", tone: "primary" },
  sensor: { label: "收集信号", short: "感知", description: "读取反馈、观察指标，并把信号送入本轮复盘。", tone: "primary" },
  builder: { label: "形成变更包", short: "执行", description: "把方向转成可审计任务、预览或回滚方案。", tone: "warning" },
  distiller: { label: "蒸馏知识", short: "蒸馏", description: "把观察与误差提炼为可治理知识。", tone: "success" },
  librarian: { label: "整理知识库", short: "审计", description: "合并重复、隔离冲突、维护知识状态。", tone: "success" },
};

export const gateTypeLabels: Record<string, LabelMeta> = {
  direction: { label: "方向决策", short: "方向", description: "决定本轮是否按推荐方向推进。", tone: "primary" },
  meaning: { label: "意义确认", short: "意义", description: "判断外部信号是否值得进入知识循环。", tone: "warning" },
  risk: { label: "风险拦截", short: "风险", description: "涉及预算、阻断、回滚或不可逆风险，通常需要先处理。", tone: "danger" },
};

export const gateStatusLabels: Record<string, LabelMeta> = {
  pending: { label: "待处理", tone: "warning" },
  approved: { label: "已批准", tone: "success" },
  rejected: { label: "已驳回", tone: "danger" },
  modified: { label: "已修改", tone: "primary" },
  resolved: { label: "已解决", tone: "success" },
};

export const knowledgeStatusLabels: Record<string, LabelMeta> = {
  draft: { label: "草稿", description: "刚生成，证据不足。", tone: "muted" },
  active: { label: "可用", description: "可参与普通决策，但还不是 strong。", tone: "primary" },
  strong: { label: "强知识", description: "经过人类闸门确认，可作为高风险证据。", tone: "success" },
  stale: { label: "待复核", description: "久未验证，默认不进入高风险证据集。", tone: "warning" },
  expired: { label: "已过期", description: "不应支持高风险动作。", tone: "warning" },
  quarantined: { label: "已隔离", description: "低质或不可信，排除出决策证据。", tone: "danger" },
  conflict: { label: "有冲突", description: "与 strong 知识冲突，等待裁决。", tone: "danger" },
};

export const confidenceLabels: Record<string, LabelMeta> = {
  low: { label: "低置信", tone: "muted" },
  medium: { label: "中置信", tone: "warning" },
  high: { label: "高置信", tone: "primary" },
  verified: { label: "已验证", tone: "success" },
};

export const cycleStatusLabels: Record<string, LabelMeta> = {
  planning: { label: "规划中", tone: "warning" },
  running: { label: "运行中", tone: "primary" },
  closed: { label: "已闭环", tone: "success" },
};

export const actorLabels: Record<string, LabelMeta> = {
  owner: { label: "项目 owner", tone: "primary" },
  human: { label: "人类审批", tone: "success" },
  scheduler: { label: "调度器", tone: "warning" },
  orchestrator: { label: "方向 Agent", tone: "primary" },
  sensor: { label: "感知 Agent", tone: "primary" },
  builder: { label: "执行 Agent", tone: "warning" },
  distiller: { label: "蒸馏 Agent", tone: "success" },
  librarian: { label: "知识管理员", tone: "success" },
};

export const operationLabels: Record<string, LabelMeta> = {
  insert: { label: "新增", tone: "primary" },
  update: { label: "更新", tone: "warning" },
  merge: { label: "合并", tone: "success" },
  approve: { label: "批准", tone: "success" },
  quarantine: { label: "隔离", tone: "danger" },
  resolve: { label: "处理闸门", tone: "success" },
};

export const schedulerActionLabels: Record<string, LabelMeta> = {
  no_cycle: { label: "项目还没有周期", tone: "muted" },
  opened_direction_gate: { label: "已打开方向闸", tone: "warning" },
  waiting_blocking_gate: { label: "等待阻塞闸门处理", tone: "danger" },
  waiting_feedback_window: { label: "等待反馈窗口结束", tone: "warning" },
  ran_operational_stages: { label: "已完成本轮执行阶段", tone: "primary" },
  created_next_cycle: { label: "已创建下一轮", tone: "success" },
  safety_mode: { label: "安全模式已触发", tone: "danger" },
};

export const errorTypeLabels: Record<string, LabelMeta> = {
  perception: { label: "感知偏差", tone: "warning" },
  execution: { label: "执行偏差", tone: "warning" },
  model: { label: "模型偏差", tone: "primary" },
  value: { label: "价值偏差", tone: "danger" },
};

export function metaFor(map: Record<string, LabelMeta>, key: string | null | undefined, fallback = "未知"): LabelMeta {
  if (!key) return { label: fallback, tone: "muted" };
  return map[key] ?? { label: key, tone: "muted" };
}

export function schedulerResultText(action?: string, note?: string): string {
  const meta = metaFor(schedulerActionLabels, action, "已推进");
  return note ? `${meta.label}: ${note}` : meta.label;
}
