import { callLlm } from "./llm";
import { detectGoalRepetition } from "./stallGuard";
import type { KnowledgeItem } from "@shared/schema";
import type { Operator } from "@shared/core/types.js";

type LlmCaller = typeof callLlm;

export interface NextGoalInput {
  cycleId: string;
  cycleIndex: number;
  identity: string;
  worldModel: string;
  eligibleKnowledge: Array<Pick<KnowledgeItem, "id" | "title" | "content" | "type" | "confidenceScore" | "status">>;
  lastCyclePredictionError: {
    eCycle: number | null;
    worstClaimError: number | null;
  };
  recentFeedback: string[];
  rejectedGoals: string[];
}

export interface NextGoalDraft {
  proposedGoal: string;
  belief: string;
  prediction: {
    statement: string;
    metric: string;
    operator: Operator;
    target: number;
  };
  action: string;
  alternativeGoals: string[];
  referencedKnowledgeIds: string[];
  reasoningHowKnowledgeChangedDecision: string;
}

const NEXT_GOAL_SCHEMA = {
  type: "object" as const,
  required: [
    "proposedGoal",
    "belief",
    "prediction",
    "action",
    "alternativeGoals",
    "referencedKnowledgeIds",
    "reasoningHowKnowledgeChangedDecision",
  ],
  additionalProperties: true,
  properties: {
    proposedGoal: { type: "string" },
    belief: { type: "string" },
    prediction: { type: "object" },
    action: { type: "string" },
    alternativeGoals: { type: "array" },
    referencedKnowledgeIds: { type: "array" },
    reasoningHowKnowledgeChangedDecision: { type: "string" },
  },
};

const AUTONOMOUS_THEMES = [
  {
    goal: "把可回滚审计扩展到批量发布前检查",
    action: "为批量发布前检查生成 dry-run 变更包、回滚步骤和审计摘要",
    metric: "activation_rate",
    target: 0.46,
  },
  {
    goal: "为团队协作审批添加差异预览和 owner 确认",
    action: "在协作审批前展示差异预览,并把 owner 确认写入审计链",
    metric: "approval_completion_rate",
    target: 0.48,
  },
  {
    goal: "把高风险动作审计摘要接入每周复盘报告",
    action: "把每次高风险动作的预览、执行和回滚结果汇总到周复盘",
    metric: "review_reuse_rate",
    target: 0.5,
  },
  {
    goal: "为外部反馈建立自动风险标签和人工复核队列",
    action: "给外部反馈打 preview/rollback/audit 风险标签,高风险项进入人工复核",
    metric: "triage_precision",
    target: 0.52,
  },
  {
    goal: "为删除类动作增加可撤销保留期和审计导出",
    action: "删除动作先进入可撤销保留区,并输出 owner 可读审计记录",
    metric: "reversal_success_rate",
    target: 0.54,
  },
  {
    goal: "把 dry-run 预览迁移到权限变更流程",
    action: "权限变更前展示影响范围、风险说明和回滚入口",
    metric: "permission_change_confidence",
    target: 0.56,
  },
  {
    goal: "建立高风险任务的最小可执行审计模板",
    action: "为高风险任务生成固定字段的执行前、执行后和回滚审计模板",
    metric: "audit_template_coverage",
    target: 0.58,
  },
  {
    goal: "对重复低价值人工闸做合并建议",
    action: "按 topicKey 合并相似意义闸,保留抽样复核和审计来源",
    metric: "gate_merge_accuracy",
    target: 0.6,
  },
  {
    goal: "为高风险自动化输出用户可理解的影响摘要",
    action: "把技术 diff 转译成用户能确认的影响摘要,再进入执行",
    metric: "impact_summary_acceptance",
    target: 0.62,
  },
  {
    goal: "把回滚触发条件变成可计算指标",
    action: "将回滚触发条件编码为 metric/operator/target 并写入预测账本",
    metric: "rollback_contract_completeness",
    target: 0.64,
  },
  {
    goal: "对沉淀知识做近义合并和来源保全",
    action: "将近义知识合并到主条目,保留 supersededBy 和证据来源",
    metric: "knowledge_merge_precision",
    target: 0.66,
  },
  {
    goal: "为强知识冲突建立人工裁决入口",
    action: "检测与 strong 知识相反的新断言,标记 conflict 并打开裁决风险闸",
    metric: "conflict_detection_recall",
    target: 0.68,
  },
  {
    goal: "把高风险知识检索默认排除 stale 和 superseded",
    action: "检索证据集默认过滤 stale/quarantined/conflict/superseded 条目",
    metric: "clean_evidence_rate",
    target: 0.7,
  },
  {
    goal: "为长期飞轮输出停滞证据摘要",
    action: "当误差不下降、目标重复或知识爆炸时生成可审查风险摘要",
    metric: "stall_gate_quality",
    target: 0.72,
  },
  {
    goal: "把用户恐惧反馈映射为可验证产品约束",
    action: "将恐惧类反馈转成预览、确认、回滚和审计四类约束",
    metric: "fear_signal_resolution",
    target: 0.74,
  },
  {
    goal: "为下一轮行动生成反事实备选和拒绝记录",
    action: "每轮给出两个备选方向,并把未选方向加入反重复集合",
    metric: "alternative_traceability",
    target: 0.76,
  },
  {
    goal: "验证审计摘要能否帮助 owner 降低复盘时间",
    action: "对 owner 复盘流程展示可追责审计摘要并测量节省时间",
    metric: "owner_review_minutes_saved",
    target: 0.78,
  },
  {
    goal: "为高风险动作建立执行前知识引用证明",
    action: "执行前列出影响本轮决策的知识 id 和改变决策的具体原因",
    metric: "knowledge_reference_completeness",
    target: 0.8,
  },
];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function predictionFrom(value: unknown, fallback: NextGoalDraft["prediction"]): NextGoalDraft["prediction"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const obj = value as Record<string, unknown>;
  const operator = obj.operator === "<=" || obj.operator === "==" ? obj.operator : ">=";
  const target = typeof obj.target === "number" && Number.isFinite(obj.target) ? obj.target : fallback.target;
  return {
    statement: typeof obj.statement === "string" && obj.statement.trim() ? obj.statement.trim() : fallback.statement,
    metric: typeof obj.metric === "string" && obj.metric.trim() ? obj.metric.trim() : fallback.metric,
    operator,
    target,
  };
}

function rankedKnowledge(input: NextGoalInput) {
  return [...input.eligibleKnowledge].sort((a, b) => {
    if (a.status !== b.status) return a.status === "strong" ? -1 : b.status === "strong" ? 1 : 0;
    if (a.confidenceScore !== b.confidenceScore) return b.confidenceScore - a.confidenceScore;
    return a.id.localeCompare(b.id);
  });
}

function fallbackDraft(input: NextGoalInput): NextGoalDraft {
  const ranked = rankedKnowledge(input);
  const refs = ranked.slice(0, Math.min(2, ranked.length)).map((item) => item.id);
  if (refs.length === 0) {
    throw new Error("autonomous goal blocked: no eligible knowledge can be referenced");
  }

  const theme = AUTONOMOUS_THEMES.find((candidate) => (
    !detectGoalRepetition(candidate.goal, input.rejectedGoals, 0.82)
  ));
  if (!theme) {
    throw new Error("autonomous goal blocked: all deterministic candidate goals repeat prior goals");
  }
  const anchor = ranked.find((item) => item.id === refs[0]) ?? ranked[0];
  const second = ranked.find((item) => item.id === refs[1]);
  const knowledgePhrase = second
    ? `${anchor.id}「${anchor.title}」和 ${second.id}「${second.title}」`
    : `${anchor.id}「${anchor.title}」`;
  const target = Math.min(0.9, +(theme.target + Math.max(0, input.cycleIndex - 5) * 0.005).toFixed(3));

  return {
    proposedGoal: theme.goal,
    belief: `历史知识显示 ${anchor.title}; 下一轮应把该约束转成更可验证的高风险动作治理能力。`,
    prediction: {
      statement: `${theme.metric} >= ${target}`,
      metric: theme.metric,
      operator: ">=",
      target,
    },
    action: theme.action,
    alternativeGoals: [
      `${theme.goal}的纯展示版本`,
      `先扩大流量而不补充${anchor.title}`,
    ],
    referencedKnowledgeIds: refs,
    reasoningHowKnowledgeChangedDecision:
      `引用 ${knowledgePhrase}: 这些知识把本轮从泛化扩张改成带预览、回滚或审计约束的实验,避免重复旧目标并保持高风险证据集干净。`,
  };
}

function validateDraft(input: NextGoalInput, draft: NextGoalDraft): string[] {
  const errors: string[] = [];
  const allowed = new Set(input.eligibleKnowledge.map((item) => item.id));
  const refs = draft.referencedKnowledgeIds.filter((id) => allowed.has(id));
  if (refs.length === 0) errors.push("referencedKnowledgeIds must include at least one eligible knowledge id");
  if (detectGoalRepetition(draft.proposedGoal, input.rejectedGoals, 0.82)) errors.push("proposedGoal repeats a rejected or previously used goal");
  if (draft.reasoningHowKnowledgeChangedDecision.trim().length < 32) errors.push("reasoningHowKnowledgeChangedDecision is too short");
  if (!refs.some((id) => draft.reasoningHowKnowledgeChangedDecision.includes(id))) {
    errors.push("reasoningHowKnowledgeChangedDecision must mention a referenced knowledge id");
  }
  if (!draft.prediction.metric.trim() || typeof draft.prediction.target !== "number") errors.push("prediction must include metric/operator/target");
  return errors;
}

export async function generateNextGoal(input: NextGoalInput, llm: LlmCaller = callLlm): Promise<NextGoalDraft> {
  const fallback = fallbackDraft(input);
  const data = await llm({
    cycleId: input.cycleId,
    agent: "orchestrator",
    promptName: "generate_autonomous_goal",
    inputSummary: `cycle ${input.cycleIndex} autonomous goal`,
    context: {
      identity: input.identity,
      worldModel: input.worldModel,
      cycleIndex: input.cycleIndex,
      eligibleKnowledge: input.eligibleKnowledge,
      lastCyclePredictionError: input.lastCyclePredictionError,
      recentFeedback: input.recentFeedback,
      rejectedGoals: input.rejectedGoals,
    },
    knowledgeSummary: input.eligibleKnowledge.map((item) => `${item.id} ${item.status} ${item.title}`).join("\n"),
    prohibited: [
      "Do not repeat rejected or already used goals.",
      "Do not reference stale, expired, quarantined, conflict, or superseded knowledge.",
      "Do not promote any knowledge to strong.",
      "Return JSON matching the schema.",
    ],
    schema: NEXT_GOAL_SCHEMA,
    mockOutput: { ...fallback },
  });

  const draft: NextGoalDraft = {
    proposedGoal: typeof data.proposedGoal === "string" && data.proposedGoal.trim() ? data.proposedGoal.trim() : fallback.proposedGoal,
    belief: typeof data.belief === "string" && data.belief.trim() ? data.belief.trim() : fallback.belief,
    prediction: predictionFrom(data.prediction, fallback.prediction),
    action: typeof data.action === "string" && data.action.trim() ? data.action.trim() : fallback.action,
    alternativeGoals: asStringArray(data.alternativeGoals).length ? asStringArray(data.alternativeGoals) : fallback.alternativeGoals,
    referencedKnowledgeIds: asStringArray(data.referencedKnowledgeIds).filter((id) => input.eligibleKnowledge.some((item) => item.id === id)),
    reasoningHowKnowledgeChangedDecision:
      typeof data.reasoningHowKnowledgeChangedDecision === "string" && data.reasoningHowKnowledgeChangedDecision.trim()
        ? data.reasoningHowKnowledgeChangedDecision.trim()
        : fallback.reasoningHowKnowledgeChangedDecision,
  };

  const errors = validateDraft(input, draft);
  if (errors.length === 0) return draft;
  const fallbackErrors = validateDraft(input, fallback);
  if (fallbackErrors.length === 0) return fallback;
  throw new Error(`autonomous goal blocked: ${[...errors, ...fallbackErrors].join("; ")}`);
}
