export type SemanticColor = "success" | "warning" | "danger" | "neutral" | "info";
export type SemanticTokenName = `semantic.${SemanticColor}`;
export type Tone = "default" | "primary" | "success" | "warning" | "danger" | "muted";

export type LabelMeta = {
  label: string;
  short?: string;
  description?: string;
  tone?: Tone;
  semantic?: SemanticColor;
  semanticToken?: SemanticTokenName;
};

export type KnowledgeStatusLabelMeta = LabelMeta & {
  patchable: boolean;
};

function semanticToken(semantic: SemanticColor): SemanticTokenName {
  return `semantic.${semantic}`;
}

export const flywheelStageNote = "这些值表示最后活跃的 Agent 名，不表示连续进度。";

export const flywheelStageLabels: Record<string, LabelMeta> = {
  idle: {
    label: "无活跃 Agent",
    short: "空闲",
    description: "当前周期还没有 Agent 运行记录。",
    tone: "muted",
    semantic: "neutral",
    semanticToken: semanticToken("neutral"),
  },
  orchestrator: {
    label: "编排 Agent",
    short: "编排",
    description: "最后活跃的是编排 Agent。",
    tone: "primary",
    semantic: "info",
    semanticToken: semanticToken("info"),
  },
  sensor: {
    label: "感知 Agent",
    short: "感知",
    description: "最后活跃的是感知 Agent。",
    tone: "primary",
    semantic: "info",
    semanticToken: semanticToken("info"),
  },
  builder: {
    label: "构建 Agent",
    short: "构建",
    description: "最后活跃的是构建 Agent。",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
  },
  distiller: {
    label: "蒸馏 Agent",
    short: "蒸馏",
    description: "最后活跃的是蒸馏 Agent。",
    tone: "success",
    semantic: "success",
    semanticToken: semanticToken("success"),
  },
  librarian: {
    label: "知识管理员 Agent",
    short: "知识管理员",
    description: "最后活跃的是知识管理员 Agent。",
    tone: "success",
    semantic: "success",
    semanticToken: semanticToken("success"),
  },
};

export const gateTypeLabels: Record<string, LabelMeta> = {
  direction: {
    label: "方向闸",
    short: "方向",
    description: "确认本轮行动方向是否成立。",
    tone: "primary",
    semantic: "info",
    semanticToken: semanticToken("info"),
  },
  meaning: {
    label: "意义闸",
    short: "意义",
    description: "确认外部信号是否值得进入知识循环。",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
  },
  risk: {
    label: "风险闸",
    short: "风险",
    description: "拦截预算、回滚、阻断或不可逆风险。",
    tone: "danger",
    semantic: "danger",
    semanticToken: semanticToken("danger"),
  },
};

export const gateStatusLabels: Record<string, LabelMeta> = {
  pending: {
    label: "待处理",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
  },
  approved: {
    label: "已批准",
    tone: "success",
    semantic: "success",
    semanticToken: semanticToken("success"),
  },
  rejected: {
    label: "已驳回",
    tone: "danger",
    semantic: "danger",
    semanticToken: semanticToken("danger"),
  },
  modified: {
    label: "已修改",
    tone: "primary",
    semantic: "info",
    semanticToken: semanticToken("info"),
  },
  resolved: {
    label: "已解决",
    tone: "success",
    semantic: "success",
    semanticToken: semanticToken("success"),
  },
};

export const knowledgeStatusLabels: Record<string, KnowledgeStatusLabelMeta> = {
  candidate: {
    label: "候选",
    description: "候选知识，当前不能通过 PATCH 直接设置。",
    tone: "muted",
    semantic: "neutral",
    semanticToken: semanticToken("neutral"),
    patchable: false,
  },
  draft: {
    label: "草稿",
    description: "刚生成，证据不足。",
    tone: "muted",
    semantic: "neutral",
    semanticToken: semanticToken("neutral"),
    patchable: true,
  },
  active: {
    label: "可用",
    description: "可参与普通决策，但还不是 strong。",
    tone: "primary",
    semantic: "info",
    semanticToken: semanticToken("info"),
    patchable: true,
  },
  strong: {
    label: "强知识",
    description: "经过确认，可作为高风险证据。",
    tone: "success",
    semantic: "success",
    semanticToken: semanticToken("success"),
    patchable: true,
  },
  provisional: {
    label: "临时",
    description: "临时知识，当前不能通过 PATCH 直接设置。",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
    patchable: false,
  },
  stale: {
    label: "待复核",
    description: "久未验证，默认不进入高风险证据集。",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
    patchable: true,
  },
  expired: {
    label: "已过期",
    description: "不应支持高风险动作。",
    tone: "warning",
    semantic: "warning",
    semanticToken: semanticToken("warning"),
    patchable: true,
  },
  conflict: {
    label: "有冲突",
    description: "与强知识冲突，等待裁决。",
    tone: "danger",
    semantic: "danger",
    semanticToken: semanticToken("danger"),
    patchable: true,
  },
  quarantined: {
    label: "已隔离",
    description: "低质或不可信，排除出决策证据。",
    tone: "danger",
    semantic: "danger",
    semanticToken: semanticToken("danger"),
    patchable: true,
  },
  deprecated: {
    label: "已废弃",
    description: "被更新知识替代，不再建议使用。",
    tone: "muted",
    semantic: "neutral",
    semanticToken: semanticToken("neutral"),
    patchable: true,
  },
  rejected: {
    label: "已拒绝",
    description: "经审核拒绝进入可用知识集。",
    tone: "danger",
    semantic: "danger",
    semanticToken: semanticToken("danger"),
    patchable: true,
  },
};

export const confidenceLabels: Record<string, LabelMeta> = {
  low: { label: "低置信", tone: "muted", semantic: "neutral", semanticToken: semanticToken("neutral") },
  medium: { label: "中置信", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  high: { label: "高置信", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  verified: { label: "已验证", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
};

export const cycleStatusLabels: Record<string, LabelMeta> = {
  planning: { label: "规划中", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  running: { label: "运行中", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  closed: { label: "已闭环", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
};

export const actorLabels: Record<string, LabelMeta> = {
  owner: { label: "项目所有者", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  human: { label: "人工审批", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  human_telegram: { label: "Telegram 人工审批", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  scheduler: { label: "调度器", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  notification_bus: { label: "通知总线", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  time_decay_scheduler: { label: "时间衰减调度器", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  orchestrator: { label: "编排 Agent", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  sensor: { label: "感知 Agent", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  builder: { label: "构建 Agent", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  distiller: { label: "蒸馏 Agent", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  librarian: { label: "知识管理员 Agent", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  llm: { label: "LLM 调用", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  trace: { label: "Trace 追踪", tone: "muted", semantic: "neutral", semanticToken: semanticToken("neutral") },
  safety: { label: "安全系统", tone: "danger", semantic: "danger", semanticToken: semanticToken("danger") },
  agent: { label: "通用 Agent", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  knowledge_injection: { label: "知识注入", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  human_gate_service: { label: "人工闸门服务", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  telegram_adapter: { label: "Telegram 适配器", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
};

export const operationLabels: Record<string, LabelMeta> = {
  insert: { label: "新增", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  update: { label: "更新", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  merge: { label: "合并", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  approve: { label: "批准", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  quarantine: { label: "隔离", tone: "danger", semantic: "danger", semanticToken: semanticToken("danger") },
  resolve: { label: "处理闸门", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
};

export const schedulerActionLabels: Record<string, LabelMeta> = {
  no_cycle: { label: "项目还没有周期", tone: "muted", semantic: "neutral", semanticToken: semanticToken("neutral") },
  opened_direction_gate: { label: "已打开方向闸", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  waiting_blocking_gate: { label: "等待阻塞闸门处理", tone: "danger", semantic: "danger", semanticToken: semanticToken("danger") },
  waiting_feedback_window: { label: "等待反馈窗口结束", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  ran_operational_stages: { label: "已完成本轮执行阶段", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  created_next_cycle: { label: "已创建下一轮", tone: "success", semantic: "success", semanticToken: semanticToken("success") },
  safety_mode: { label: "安全模式已触发", tone: "danger", semantic: "danger", semanticToken: semanticToken("danger") },
};

export const errorTypeLabels: Record<string, LabelMeta> = {
  perception: { label: "感知偏差", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  execution: { label: "执行偏差", tone: "warning", semantic: "warning", semanticToken: semanticToken("warning") },
  model: { label: "模型偏差", tone: "primary", semantic: "info", semanticToken: semanticToken("info") },
  value: { label: "价值偏差", tone: "danger", semantic: "danger", semanticToken: semanticToken("danger") },
};

export function metaFor<T extends LabelMeta>(map: Record<string, T>, key: string | null | undefined, fallback = "未知"): T | LabelMeta {
  if (!key) return { label: fallback, tone: "muted", semantic: "neutral", semanticToken: semanticToken("neutral") };
  return map[key] ?? { label: key, tone: "muted", semantic: "neutral", semanticToken: semanticToken("neutral") };
}

export function schedulerResultText(action?: string, note?: string): string {
  const meta = metaFor(schedulerActionLabels, action, "已推进");
  return note ? `${meta.label}: ${note}` : meta.label;
}
