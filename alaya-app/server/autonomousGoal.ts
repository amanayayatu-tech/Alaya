import { callLlm } from "./llm";
import { detectGoalRepetition } from "./stallGuard";
import type { KnowledgeItem } from "@shared/schema";
import type { Operator } from "alaya-core/src/core/types.js";

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

const NEXT_GOAL_OUTPUT_CONTRACT = {
  prompt: "generate_autonomous_goal",
  requiredKeys: [
    "proposedGoal",
    "belief",
    "prediction",
    "action",
    "alternativeGoals",
    "referencedKnowledgeIds",
    "reasoningHowKnowledgeChangedDecision",
  ],
  predictionShape: {
    statement: "string",
    metric: "string",
    operator: ">= | <= | =",
    target: "number",
  },
  rules: [
    "Return only one JSON object with exactly the required top-level keys.",
    "Use empty arrays as [] for alternativeGoals or referencedKnowledgeIds when no safe value exists.",
    "Use only referencedKnowledgeIds that appear in eligibleKnowledge.",
    "Do not wrap JSON in markdown, prose, XML, or thinking blocks.",
  ],
  minimalExample: {
    proposedGoal: "C7 rollback preview holdout comparison",
    belief: "kb_1 shows rollback preview reduces operator hesitation.",
    prediction: {
      statement: "rollback_preview_completion_rate >= 0.5",
      metric: "rollback_preview_completion_rate",
      operator: ">=",
      target: 0.5,
    },
    action: "Run a rollback preview holdout comparison using approved knowledge only.",
    alternativeGoals: [],
    referencedKnowledgeIds: ["kb_1"],
    reasoningHowKnowledgeChangedDecision: "kb_1 changed the next goal toward rollback preview validation.",
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

const ADAPTIVE_AXES = [
  {
    goal: "建立异常回放台账验证知识引用质量",
    action: "把本轮关键知识引用、异常反馈和人工裁决结果写入可回放台账",
    metric: "replay_trace_completeness",
    target: 0.74,
  },
  {
    goal: "校准证据冲突的人工作业采样策略",
    action: "按冲突主题抽样人工复核,并记录采样结论对后续复用阈值的影响",
    metric: "conflict_sampling_precision",
    target: 0.75,
  },
  {
    goal: "验证低置信知识进入决策前的隔离效果",
    action: "对低置信外部反馈先做隔离复核,只允许通过复核的条目进入下一轮证据集",
    metric: "low_confidence_quarantine_rate",
    target: 0.76,
  },
  {
    goal: "把人工审批结果转成可检索的决策影响摘要",
    action: "为每个已决闸门生成决策影响摘要,并在下一轮目标生成时引用",
    metric: "decision_impact_reuse_rate",
    target: 0.77,
  },
  {
    goal: "检验强知识更新时的反例吸收路径",
    action: "把与强知识相关的反例拆成风险、范围和适用条件,避免直接覆盖原结论",
    metric: "counterexample_absorption_rate",
    target: 0.78,
  },
  {
    goal: "把重复反馈自动合并后的抽样复核变成指标",
    action: "统计重复意义闸自动合并后的人工抽样命中率,并回写阈值调整建议",
    metric: "merged_gate_sample_accuracy",
    target: 0.79,
  },
  {
    goal: "验证长期飞轮是否产生跨轮知识引用链",
    action: "为最近三轮生成知识引用链,检查本轮行动是否被上一轮证据实际改变",
    metric: "cross_round_reference_chain_rate",
    target: 0.8,
  },
  {
    goal: "为风险闸批准后的恢复路径建立审计证明",
    action: "记录风险闸批准后调度器如何恢复下一轮,并验证没有无待审安全模式",
    metric: "risk_gate_recovery_success_rate",
    target: 0.81,
  },
  {
    goal: "把过期知识降级结果纳入下一轮目标选择",
    action: "在生成下一轮目标前排除过期和降级知识,并记录被排除知识对方向选择的影响",
    metric: "stale_exclusion_trace_rate",
    target: 0.82,
  },
  {
    goal: "验证知识爆炸风险下的合并保真度",
    action: "对高增长知识簇执行近义合并,保留来源、supersededBy 和人工可审摘要",
    metric: "knowledge_merge_fidelity",
    target: 0.83,
  },
  {
    goal: "建立预算闸对后续任务节流的效果评估",
    action: "在预算闸批准后降低低价值闸门频率,并观察人工队列是否真实下降",
    metric: "budget_throttle_effectiveness",
    target: 0.84,
  },
  {
    goal: "验证外部反馈主题漂移时的重新开闸机制",
    action: "检测同一 topicKey 中的新矛盾表达,主题漂移时强制重新进入人工复核",
    metric: "topic_drift_regate_recall",
    target: 0.85,
  },
];

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function predictionFrom(value: unknown, fallback: NextGoalDraft["prediction"]): NextGoalDraft["prediction"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const obj = value as Record<string, unknown>;
  const operator = obj.operator === "<=" ? "<=" : ">=";
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

function topRefs(input: NextGoalInput) {
  const ranked = rankedKnowledge(input);
  const refs = ranked.slice(0, Math.min(2, ranked.length)).map((item) => item.id);
  if (refs.length === 0) {
    throw new Error("autonomous goal blocked: no eligible knowledge can be referenced");
  }
  return { ranked, refs };
}

function deterministicTheme(input: NextGoalInput) {
  return AUTONOMOUS_THEMES.find((candidate) => (
    !detectGoalRepetition(candidate.goal, input.rejectedGoals, 0.82)
  ));
}

function adaptiveTheme(input: NextGoalInput) {
  const axis = ADAPTIVE_AXES[Math.abs(input.cycleIndex - 1) % ADAPTIVE_AXES.length];
  const batch = Math.floor(Math.max(0, input.cycleIndex - 1) / ADAPTIVE_AXES.length) + 1;
  return {
    goal: `${axis.goal}（第${input.cycleIndex}轮·批次${batch}）`,
    action: axis.action,
    metric: axis.metric,
    target: axis.target,
  };
}

function fallbackDraft(input: NextGoalInput): NextGoalDraft {
  const { ranked, refs } = topRefs(input);
  const theme = deterministicTheme(input) ?? adaptiveTheme(input);
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

function recoveryDraft(input: NextGoalInput): NextGoalDraft {
  const { ranked, refs } = topRefs(input);
  const primaryAxis = ADAPTIVE_AXES[Math.abs(input.cycleIndex - 1) % ADAPTIVE_AXES.length];
  const secondaryAxis = ADAPTIVE_AXES[Math.abs(input.cycleIndex + Math.floor(input.cycleIndex / ADAPTIVE_AXES.length)) % ADAPTIVE_AXES.length];
  const anchor = ranked.find((item) => item.id === refs[0]) ?? ranked[0];
  const sampleStart = Math.max(1, input.cycleIndex - 2);
  const candidates = [
    `C${input.cycleIndex} ${primaryAxis.metric} isolated replay proof`,
    `第${input.cycleIndex}轮样本窗口${sampleStart}-${input.cycleIndex}: ${primaryAxis.metric} 独立复测`,
    `C${input.cycleIndex} ${primaryAxis.metric}_x_${secondaryAxis.metric} evidence reuse audit`,
    `C${input.cycleIndex} checkpoint ${primaryAxis.metric}_${input.cycleId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(-16)}`,
  ];
  const proposedGoal = candidates.find((candidate) => !detectGoalRepetition(candidate, input.rejectedGoals, 0.82)) ?? candidates[candidates.length - 1];
  const target = Math.min(0.92, +(primaryAxis.target + 0.01).toFixed(3));

  return {
    proposedGoal,
    belief: `历史目标生成已多次靠近重复模板；下一轮用 ${primaryAxis.metric} 的独立样本窗口复测来验证知识复用，而不是再生成同构 weekly 复盘目标。`,
    prediction: {
      statement: `${primaryAxis.metric}_independent_recheck >= ${target}`,
      metric: `${primaryAxis.metric}_independent_recheck`,
      operator: ">=",
      target,
    },
    action: `对样本窗口 ${sampleStart}-${input.cycleIndex} 独立复测 ${primaryAxis.metric}，只引用已批准知识并记录与历史模板不同的证据链。`,
    alternativeGoals: [
      `C${input.cycleIndex} ${secondaryAxis.metric} isolated audit`,
      `C${input.cycleIndex} ${primaryAxis.metric} holdout comparison`,
    ],
    referencedKnowledgeIds: refs,
    reasoningHowKnowledgeChangedDecision:
      `引用 ${refs.join(", ")}，尤其是 ${anchor.id}「${anchor.title}」: Stall Guard 证据显示原目标模板重复，因此本轮改成独立样本窗口复测，保持知识引用但改变可观测问题。`,
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
      outputContract: NEXT_GOAL_OUTPUT_CONTRACT,
    },
    knowledgeSummary: input.eligibleKnowledge.map((item) => `${item.id} ${item.status} ${item.title}`).join("\n"),
    prohibited: [
      "Do not repeat rejected or already used goals.",
      "Do not reference stale, expired, quarantined, conflict, or superseded knowledge.",
      "Do not promote any knowledge to strong.",
      "Return only one JSON object for generate_autonomous_goal with exact keys: proposedGoal, belief, prediction, action, alternativeGoals, referencedKnowledgeIds, reasoningHowKnowledgeChangedDecision.",
      "Use empty arrays as [] for alternativeGoals or referencedKnowledgeIds when no safe values exist; prediction.target must be a number.",
    ],
    schema: NEXT_GOAL_SCHEMA,
    simplifiedSchema: NEXT_GOAL_SCHEMA,
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
  const recovery = recoveryDraft(input);
  const recoveryErrors = validateDraft(input, recovery);
  if (recoveryErrors.length === 0) return recovery;
  throw new Error(`autonomous goal blocked: ${[...errors, ...fallbackErrors, ...recoveryErrors].join("; ")}`);
}
