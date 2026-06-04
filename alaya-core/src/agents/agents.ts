/**
 * 5 Agent 顺序调度 (PRD 7、13)。
 * MVP 保留五个角色、五段职责、五类运行记录(PRD 3.2 硬约束:不得砍成单 Agent)。
 * 每个 Agent 每轮都写运行记录(PRD 17.3)。
 */

import { Store } from "../state/store.js";
import { LLMProvider, JsonSchema } from "../llm/provider.js";
import { CycleScenario } from "../sim/scenario.js";
import {
  computeClaimError,
  computeCycleError,
} from "../core/compute_error.js";
import { classifyError, routeError } from "../core/classify_error.js";
import { applyEvidence } from "../core/update_confidence.js";
import { transitionState } from "../core/transition_state.js";
import { evidenceCount } from "../core/types.js";
import type {
  Claim,
  Prediction,
  KnowledgeItem,
  HumanGate,
  AttributionContext,
} from "../core/types.js";

const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  required: ["goal", "belief", "prediction", "action", "reasoning", "knowledgeRefs"],
  additionalProperties: true,
  properties: {
    goal: { type: "string" },
    belief: { type: "string" },
    prediction: { type: "string" },
    action: { type: "string" },
    reasoning: { type: "string" },
    knowledgeRefs: { type: "array" },
  },
};

const SENSOR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary", "unclearSignals"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    unclearSignals: { type: "array" },
  },
};

const BUILDER_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary", "buildSuccess", "diffSummary", "testReport"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    buildSuccess: { type: "boolean" },
    diffSummary: { type: "string" },
    testReport: { type: "string" },
  },
};

const DISTILLER_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary", "knowledgeCandidates"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    knowledgeCandidates: { type: "array" },
  },
};

const LIBRARIAN_SCHEMA: JsonSchema = {
  type: "object",
  required: ["summary", "transitions"],
  additionalProperties: true,
  properties: {
    summary: { type: "string" },
    transitions: { type: "array" },
  },
};

let kbCounter = 0;
function newKnowledge(
  cycleIndex: number,
  partial: Pick<KnowledgeItem, "type" | "title" | "content" | "sourceType" | "sourceRef" | "tags" | "notes">,
): KnowledgeItem {
  return {
    id: `kb_${String(++kbCounter).padStart(3, "0")}`,
    projectId: "proj_001",
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "draft",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-03",
    validUntil: null,
    lastValidatedCycle: cycleIndex,
    createdByCycle: cycleIndex,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    ...partial,
  };
}

function rollbackReadyChangePackage(sc: CycleScenario, action: string) {
  if (sc.index !== 4) return undefined;
  return {
    packageType: "rollback-ready change package",
    modifiedObjects: [
      "high-risk action execution plan",
      "dry-run preview result",
      "release audit log",
    ],
    intendedAction: action,
    rollbackTrigger: "activation_rate < 0.45 或出现新的不可逆/不可追责负面反馈",
    rollbackSteps: [
      "停止自动执行入口,仅保留 dry-run 预览",
      "恢复第3轮删除预览策略",
      "把失败样本写入 meaning gate 交由 owner 复盘",
    ],
    riskLevel: "high",
  };
}

function auditSummaryForCycle4(refs: string[]) {
  return {
    stage: "cycle_4_rollback_audit",
    whyNow: "第2-3轮已经证明预览能降低恐惧,第4轮验证用户是否愿意把更多高风险动作交给系统持续处理。",
    deltaFromCycle3: "第3轮解决看到将改什么;第4轮新增执行后可回滚与全过程可追责。",
    verificationConstraints: [
      "必须有 rollbackPlan",
      "必须有 auditSummary",
      "不得跳过方向闸",
      "不得执行不可逆动作",
    ],
    knowledgeRefs: refs,
  };
}

function safeKnowledgeRefs(store: Store, proposed: unknown, fallback: string[]): string[] {
  const allowed = new Set(store.activeKnowledge().map((k) => k.id));
  const refs = Array.isArray(proposed)
    ? proposed.filter((r): r is string => typeof r === "string" && allowed.has(r))
    : [];
  return refs.length > 0 || fallback.length === 0 ? refs : fallback;
}

function includesCycle3Compounding(reasoning: string): boolean {
  return /改变|迁移|复用|change|reuse|compound/i.test(reasoning);
}

function includesCycle4RollbackAudit(...parts: string[]): boolean {
  const text = parts.join(" ");
  return /回滚|审计|rollback|audit/i.test(text);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function mergeTags(required: string[], proposed: unknown): string[] {
  return Array.from(new Set([...required, ...stringArray(proposed)]));
}

function knowledgeCandidate(llmData: Record<string, unknown>, index: number): Record<string, unknown> {
  const candidates = Array.isArray(llmData.knowledgeCandidates) ? llmData.knowledgeCandidates : [];
  const objects = candidates.filter((item): item is Record<string, unknown> => (
    item !== null && typeof item === "object" && !Array.isArray(item)
  ));
  return objects.find((item) => Number(item.createdByCycle) === index) ?? objects[0] ?? {};
}

async function callAgentLlm(
  store: Store,
  cycleIndex: number,
  llm: LLMProvider,
  request: {
    role: string;
    task: string;
    schema: JsonSchema;
    context: Record<string, unknown>;
    mockData: Record<string, unknown>;
    knowledgeSummary?: string;
  },
): Promise<Record<string, unknown>> {
  const response = await llm.call({
    role: request.role,
    task: request.task,
    promptVersion: `${request.task}@v1`,
    schema: request.schema,
    simplifiedSchema: {
      type: "object",
      required: ["summary"],
      additionalProperties: true,
      properties: { summary: { type: "string" } },
    },
    context: request.context,
    knowledgeSummary: request.knowledgeSummary,
    prohibited: [
      "Do not decide knowledge confidence; evidence counters do that.",
      "Do not execute external irreversible actions.",
      "Return JSON only.",
      "Include every required schema key; for empty arrays return [] instead of omitting the key.",
    ],
    mockData: request.mockData,
  });
  store.recordLlmCall(cycleIndex, response.log);

  if (response.degradedToHumanGate) {
    store.gates.push({
      id: `gate_llm_${cycleIndex}_${request.role}_${store.llmCalls.length}`,
      cycleId: `cycle_${cycleIndex}`,
      type: "meaning",
      blocking: false,
      title: `LLM 输出降级: ${request.role}/${request.task}`,
      payload: {
        error: response.errorMessage ?? "schema validation failed",
        promptVersion: response.log.promptVersion,
      },
      status: "pending",
      estimatedMinutes: 5,
    });
  }

  return response.data;
}

// ---------------- Orchestrator ----------------
/**
 * 读取 identity/world_model/上轮结果,生成本轮目标与预测。
 * 复利核心:第3轮主动引用前两轮 strong/active 知识,改变目标,避开已否决方向。
 */
export async function runOrchestrator(store: Store, sc: CycleScenario, llm: LLMProvider) {
  let goal = sc.proposedGoal;
  let belief = sc.belief;
  let prediction = sc.prediction;
  let action = sc.action;
  const refs: string[] = [];
  let reasoning = "";

  if (sc.index === 3) {
    // 基于前两轮知识动态生成目标 —— 这是真正的复利证据
    const usable = store.activeKnowledge();
    const previewKnowledge = usable.find((k) => k.tags.includes("preview"));
    const fearKnowledge = usable.find((k) => k.tags.includes("user_fear"));
    if (previewKnowledge) refs.push(previewKnowledge.id);
    if (fearKnowledge) refs.push(fearKnowledge.id);

    goal = "为删除操作也加 dry-run 预览,把可预览模式推广到其他高风险动作";
    belief = "可预览/可逆能降低高风险动作门槛(沿用前两轮验证过的知识)";
    prediction = "为删除加预览后,activation 进一步升到 30% 以上且无新增恐惧反馈";
    action = "把发布预览模式复用到删除流程";
    reasoning =
      `引用 ${refs.join("+")}: 前两轮证明"用户对不可预期自动操作有恐惧(K1)"且` +
      `"可预览显著降低门槛(K2)",因此本轮不再新增不可预览的自动化,` +
      `而是把已验证的预览模式迁移到删除操作。这改变了候选目标的选择。`;
  } else if (sc.index === 4) {
    const usable = store.activeKnowledge();
    const previewKnowledge = usable.find((k) => k.tags.includes("preview"));
    const fearKnowledge = usable.find((k) => k.tags.includes("user_fear"));
    const auditKnowledge = usable.find((k) => k.tags.includes("auditability"));
    if (previewKnowledge) refs.push(previewKnowledge.id);
    if (fearKnowledge) refs.push(fearKnowledge.id);
    if (auditKnowledge) refs.push(auditKnowledge.id);

    goal = "把 dry-run 预览升级为可回滚变更包,并为每次高风险动作生成审计摘要";
    belief = "高风险自动化要继续扩大适用范围,必须同时满足可预览、可回滚、可追溯";
    prediction = "加入回滚与审计摘要后,activation 达到 45% 以上且正向复盘反馈增加";
    action = "开发变更包回滚入口 + 自动审计摘要";
    reasoning =
      `引用 ${refs.join("+") || "前轮高风险动作知识"}: 第2-3轮证明预览能降低恐惧,` +
      `第4轮不再只扩展动作种类,而是补齐回滚与审计,把用户信任从"敢点一次"` +
      `提升到"愿意交给系统持续处理"。`;
  } else {
    reasoning = `第 ${sc.index} 轮:基于 onboarding seed 与上轮误差生成目标`;
  }

  const fallbackPlan = { goal, belief, prediction, action, reasoning, knowledgeRefs: [...refs] };

  const llmData = await callAgentLlm(store, sc.index, llm, {
    role: "orchestrator",
    task: "plan_cycle",
    schema: PLAN_SCHEMA,
    context: {
      cycleIndex: sc.index,
      proposedGoal: sc.proposedGoal,
      activeKnowledge: store.activeKnowledge().map((k) => ({
        id: k.id,
        title: k.title,
        tags: k.tags,
        status: k.status,
      })),
      rejectedDirections: [...store.rejectedDirections],
    },
    mockData: { goal, belief, prediction, action, reasoning, knowledgeRefs: refs },
  });

  goal = typeof llmData.goal === "string" ? llmData.goal : goal;
  belief = typeof llmData.belief === "string" ? llmData.belief : belief;
  prediction = typeof llmData.prediction === "string" ? llmData.prediction : prediction;
  action = typeof llmData.action === "string" ? llmData.action : action;
  reasoning = typeof llmData.reasoning === "string" ? llmData.reasoning : reasoning;
  refs.splice(0, refs.length, ...safeKnowledgeRefs(store, llmData.knowledgeRefs, fallbackPlan.knowledgeRefs));

  if (sc.index === 3 && (refs.length < 2 || !includesCycle3Compounding(reasoning))) {
    goal = fallbackPlan.goal;
    belief = fallbackPlan.belief;
    prediction = fallbackPlan.prediction;
    action = fallbackPlan.action;
    reasoning = fallbackPlan.reasoning;
    refs.splice(0, refs.length, ...fallbackPlan.knowledgeRefs);
  }

  if (sc.index === 4 && !includesCycle4RollbackAudit(goal, belief, prediction, action, reasoning)) {
    goal = fallbackPlan.goal;
    belief = fallbackPlan.belief;
    prediction = fallbackPlan.prediction;
    action = fallbackPlan.action;
    reasoning = fallbackPlan.reasoning;
    refs.splice(0, refs.length, ...fallbackPlan.knowledgeRefs);
  }

  const rollbackPlan = rollbackReadyChangePackage(sc, action);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;

  // 方向闸 (PRD 11.1)
  const gate: HumanGate = {
    id: sc.index === 4 ? "gate_dir_c4_rollback" : `gate_dir_${sc.index}`,
    cycleId: `cycle_${sc.index}`,
    type: "direction",
    blocking: true,
    title: sc.index === 4 ? "第 4 轮可回滚执行闸: 变更包 + 审计摘要" : `第 ${sc.index} 轮方向闸`,
    payload: {
      recommended: goal,
      alternatives: sc.alternativeGoals,
      knowledgeRefs: refs,
      reasoning,
      belief,
      prediction,
      action,
      ...(rollbackPlan ? { rollbackPlan, rollbackTrigger: rollbackPlan.rollbackTrigger } : {}),
      ...(auditSummary ? { auditSummary } : {}),
    },
    status: "pending",
    estimatedMinutes: 10,
  };
  store.gates.push(gate);

  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "orchestrator",
    action: "plan_cycle + open_direction_gate",
    outputSummary: `目标: ${goal}${refs.length ? ` | 引用知识: ${refs.join(",")}` : ""}`,
    knowledgeRefsUsed: refs,
  });

  return { goal, belief, prediction, action, refs, reasoning, gate };
}

// ---------------- 人类闸门处理(mock 人类) ----------------
export function humanResolveDirectionGate(store: Store, gate: HumanGate, sc: CycleScenario) {
  // mock 人类:批准推荐目标;并把未选中的备选记入(不重复提已否决方向)
  gate.status = "approved";
  gate.decision = "approve_recommended";
  for (const alt of sc.alternativeGoals) store.rejectedDirections.add(alt);
  store.decisionLog.push({
    cycleIndex: sc.index,
    gateType: "direction",
    decision: "approve_recommended",
    rationale: sc.index === 4
      ? "批准第4轮可回滚变更包:方向来自前轮 preview/user_fear 知识,新增 rollbackPlan 与 auditSummary 作为执行约束。"
      : "推荐目标与已验证知识一致",
  });
}

// ---------------- Sensor ----------------
export async function runSensor(store: Store, sc: CycleScenario, llm: LLMProvider) {
  const bugs = sc.feedback.filter((f) => f.category === "bug");
  const unclear = sc.feedback.filter((f) => f.category === "unclear_signal");
  await callAgentLlm(store, sc.index, llm, {
    role: "sensor",
    task: "cluster_feedback",
    schema: SENSOR_SCHEMA,
    context: { feedback: sc.feedback },
    mockData: {
      summary: `反馈 ${sc.feedback.length} 条,bug ${bugs.length},模糊 ${unclear.length}`,
      unclearSignals: unclear.map((u) => ({ id: u.id, text: u.text })),
    },
  });

  // 模糊信号 -> 意义闸候选 (PRD 13.3)
  for (const u of unclear) {
    store.gates.push({
      id: `gate_meaning_${sc.index}_${u.id}`,
      cycleId: `cycle_${sc.index}`,
      type: "meaning",
      blocking: false,
      title: `模糊反馈意义闸: ${u.text.slice(0, 12)}...`,
      payload: { userQuote: u.text },
      status: "pending",
      estimatedMinutes: 8,
    });
  }

  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "sensor",
    action: "import_and_cluster_feedback",
    outputSummary: `反馈 ${sc.feedback.length} 条 (bug ${bugs.length}, 模糊 ${unclear.length}),保留原话`,
    knowledgeRefsUsed: [],
  });
  return { unclear };
}

// ---------------- Builder Adapter ----------------
export async function runBuilder(store: Store, sc: CycleScenario, llm: LLMProvider, plannedAction = sc.action, refs: string[] = []) {
  // MVP:mock build report,不真正改代码 (PRD 7.3 / 18.5)
  const rollbackPlan = rollbackReadyChangePackage(sc, plannedAction);
  const auditSummary = sc.index === 4 ? auditSummaryForCycle4(refs) : undefined;
  const fallbackReport = {
    buildSuccess: sc.buildSuccess,
    testReport: sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)",
    diffSummary: `mock diff for: ${plannedAction}`,
    ...(rollbackPlan ? { rollbackPlan, rollbackTrigger: rollbackPlan.rollbackTrigger } : {}),
    ...(auditSummary ? { auditSummary } : {}),
  };
  const llmData = await callAgentLlm(store, sc.index, llm, {
    role: "builder",
    task: "emit_task_spec",
    schema: BUILDER_SCHEMA,
    context: { action: plannedAction, rollbackPlan, auditSummary },
    mockData: { summary: fallbackReport.diffSummary, ...fallbackReport },
  });
  const report = {
    ...fallbackReport,
    // Tool-side build success remains authoritative; LLM may only shape the auditable task spec text.
    llmReportedBuildSuccess: typeof llmData.buildSuccess === "boolean" ? llmData.buildSuccess : null,
    diffSummary: nonEmptyString(llmData.diffSummary, fallbackReport.diffSummary),
    testReport: nonEmptyString(llmData.testReport, fallbackReport.testReport),
  };
  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "builder",
    action: "emit_task_spec + receive_mock_build_report",
    outputSummary: `build=${report.buildSuccess ? "成功" : "失败"} | ${report.diffSummary}${rollbackPlan ? " | rollback-ready change package + audit summary" : ""}`,
    knowledgeRefsUsed: refs,
  });
  return report;
}

// ---------------- 预测与误差评估 ----------------
export function evaluatePrediction(
  store: Store,
  sc: CycleScenario,
  plan: { belief: string; prediction: string; action: string; refs: string[] },
) {
  const claim: Claim = {
    id: `claim_${sc.index}`,
    type: "metric_threshold",
    metric: "activation_rate",
    operator: ">=",
    target: sc.activationTarget,
    observed: sc.activationObserved,
    scale: sc.activationTarget,
    weight: 3, // 关键预测高权重 (修复漏洞C)
    expectedObservation: `activation_rate >= ${sc.activationTarget}`,
    timeWindow: `cycle_${sc.index}_feedback_window`,
    successThreshold: `activation_rate >= ${sc.activationTarget}`,
    failureThreshold: `activation_rate < ${sc.activationTarget}`,
    uncertainty: sc.index === 1 ? 0.42 : sc.index === 4 ? 0.28 : 0.32,
  };
  claim.error = computeClaimError(claim);
  const cycleErr = computeCycleError([claim]);

  const pred: Prediction = {
    id: sc.index === 4 ? "pred_c4_rollback" : `pred_${sc.index}`,
    cycleId: `cycle_${sc.index}`,
    belief: plan.belief,
    prediction: plan.prediction,
    action: plan.action,
    claims: [claim],
    observation: `activation_rate = ${sc.activationObserved}`,
    predictionError: cycleErr.eCycle,
    worstClaimError: cycleErr.worstClaimError,
    status: "resolved",
    knowledgeRefs: plan.refs,
  };

  // 误差归因 (PRD 10.6)
  const ctx: AttributionContext = {
    perceptionFailure: !sc.perceptionOk,
    executionFailure: !sc.buildSuccess,
    humanFlaggedValueMismatch: sc.humanValueMismatch,
    isQualitative: false,
  };
  pred.errorType = classifyError(claim.error, ctx);
  pred.updateTarget = routeError(pred.errorType);
  store.predictions.push(pred);
  return { pred, claim };
}

// ---------------- Distiller ----------------
/**
 * 从预测误差和反馈提炼知识候选 (PRD 7.4, 9.2)。
 * 第1轮失败 -> 提炼 K1(用户恐惧);第2轮成功 -> 强化 K1 + 提炼 K2(可预览降门槛)。
 */
export function runDistiller(
  store: Store,
  sc: CycleScenario,
  pred: Prediction,
  claimError: number,
  llm: LLMProvider,
): Promise<string[]> {
  return runDistillerInner(store, sc, pred, claimError, llm);
}

async function runDistillerInner(
  store: Store,
  sc: CycleScenario,
  pred: Prediction,
  claimError: number,
  llm: LLMProvider,
) {
  const llmData = await callAgentLlm(store, sc.index, llm, {
    role: "distiller",
    task: "distill_knowledge",
    schema: DISTILLER_SCHEMA,
    context: {
      prediction: pred,
      feedback: sc.feedback,
      claimError,
      decisionLog: store.decisionLog,
    },
    mockData: {
      summary: `cycle ${sc.index} distillation`,
      knowledgeCandidates: [],
    },
  });
  const candidate = knowledgeCandidate(llmData, sc.index);
  const created: string[] = [];

  if (sc.index === 1) {
    // 预测失败 + 反馈揭示恐惧 -> 新知识 K1
    const k1 = newKnowledge(1, {
      type: "world_model",
      title: nonEmptyString(candidate.title, "用户对不可预期的自动操作有恐惧"),
      content: nonEmptyString(candidate.content, "早期用户不敢用一键发布,因为不知道会改动什么。恐惧而非能力是采用门槛。"),
      sourceType: "feedback",
      sourceRef: nonEmptyString(candidate.sourceRef, "f1,f2"),
      tags: mergeTags(["user_fear", "adoption"], candidate.tags),
      notes: nonEmptyString(candidate.notes, "由第1轮预测失败 + 两条负面反馈提炼"),
    });
    // 失败的旧 belief 也记为反证(world_model 修正)
    const r = applyEvidence(k1, { kind: "prediction", normalizedError: claimError });
    store.upsertKnowledge("distiller", 1, r.next);
    created.push(r.next.id);
  }

  if (sc.index === 2) {
    // K1 在第2轮得到正面验证(预测成功,恐惧被预览缓解)
    const k1 = [...store.knowledge.values()].find((k) => k.tags.includes("user_fear"));
    if (k1) {
      // 第2轮预测成功(error低)-> 支持 K1
      const r = applyEvidence(k1, { kind: "prediction", normalizedError: claimError });
      // 正面反馈 f3/f4 印证了"恐惧->预览解法",作为独立来源验证 (PRD 8.6: 外部来源 alpha+=2)
      const r2 = applyEvidence(r.next, { kind: "external_verify" });
      store.upsertKnowledge("distiller", 2, { ...r2.next, lastValidatedCycle: 2 });
    }
    // 提炼 K2
    const k2 = newKnowledge(2, {
      type: "principle",
      title: nonEmptyString(candidate.title, "可预览/可逆显著降低高风险动作使用门槛"),
      content: nonEmptyString(candidate.content, "为发布加 dry-run 预览后 activation 达标。预览把不可逆恐惧转为可控。"),
      sourceType: "metric",
      sourceRef: nonEmptyString(candidate.sourceRef, "claim_2,f3,f4"),
      tags: mergeTags(["preview", "principle", "high_risk"], candidate.tags),
      notes: nonEmptyString(candidate.notes, "由第2轮预测成功 + 正面反馈提炼"),
    });
    const r2 = applyEvidence(k2, { kind: "prediction", normalizedError: claimError });
    store.upsertKnowledge("distiller", 2, r2.next);
    created.push(r2.next.id);
  }

  if (sc.index === 3) {
    // 第3轮:复用的 K1+K2 再次被验证,获得人类批准晋级证据
    for (const k of store.activeKnowledge()) {
      if (k.tags.includes("preview") || k.tags.includes("user_fear")) {
        const r = applyEvidence(k, { kind: "prediction", normalizedError: claimError });
        const r2 = applyEvidence(r.next, { kind: "human_approve" }); // mock 人类批准
        store.upsertKnowledge("distiller", 3, { ...r2.next, lastValidatedCycle: 3 });
      }
    }
  }

  if (sc.index === 4) {
    for (const k of store.activeKnowledge()) {
      if (k.tags.includes("preview") || k.tags.includes("user_fear")) {
        const r = applyEvidence(k, { kind: "prediction", normalizedError: claimError });
        const r2 = applyEvidence(r.next, { kind: "external_verify" });
        store.upsertKnowledge("distiller", 4, {
          ...r2.next,
          lastValidatedCycle: 4,
          usageCount: r2.next.usageCount + 1,
        });
      }
    }

    const k4 = newKnowledge(4, {
      type: "principle",
      title: nonEmptyString(candidate.title, "高风险动作进入执行前必须具备可回滚路径与审计摘要"),
      content: nonEmptyString(candidate.content, "第4轮把第3轮的 dry-run 预览升级为 rollback-ready change package: 高风险动作在进入执行前必须声明拟修改对象、回滚触发条件、回滚步骤、风险级别,并生成 audit summary 供 owner 复盘。"),
      sourceType: "metric",
      sourceRef: nonEmptyString(candidate.sourceRef, "claim_4,f6,f7"),
      tags: mergeTags(["rollback", "auditability", "principle", "high_risk"], candidate.tags),
      notes: nonEmptyString(candidate.notes, "由第4轮预测成功 + 正向复盘反馈提炼"),
    });
    const r = applyEvidence(k4, { kind: "prediction", normalizedError: claimError });
    const r2 = applyEvidence(r.next, { kind: "external_verify" });
    store.upsertKnowledge("distiller", 4, r2.next);
    created.push(r2.next.id);
  }

  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "distiller",
    action: "distill_knowledge_candidates",
    outputSummary: created.length ? `生成知识候选: ${created.join(",")}` : "强化既有知识证据",
    knowledgeRefsUsed: pred.knowledgeRefs ?? [],
  });
  return created;
}

// ---------------- Librarian ----------------
/**
 * 知识库整理:状态迁移、晋级、冲突标记 (PRD 7.5, 9.3)。
 * 增量处理,不全库扫描 (PRD 18.4)。
 */
export async function runLibrarian(store: Store, sc: CycleScenario, llm: LLMProvider) {
  await callAgentLlm(store, sc.index, llm, {
    role: "librarian",
    task: "audit_and_merge",
    schema: LIBRARIAN_SCHEMA,
    context: {
      knowledge: [...store.knowledge.values()].map((k) => ({
        id: k.id,
        status: k.status,
        confidenceScore: k.confidenceScore,
        tags: k.tags,
      })),
    },
    mockData: { summary: "incremental audit", transitions: [] },
  });
  const transitions: string[] = [];

  for (const k of store.knowledge.values()) {
    const r = transitionState(k, {
      currentCycle: sc.index,
      conflictsWithStrong: false,
      humanApprovedStrongPromotion: k.humanApprovedCount >= 1, // 第3轮人类已批准
    });
    if (r.changed) {
      store.upsertKnowledge("librarian", sc.index, { ...k, status: r.nextStatus });
      transitions.push(`${k.id}: ${k.status}->${r.nextStatus} (${r.reason})`);
    }
  }

  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "librarian",
    action: "audit_merge_transition",
    outputSummary: transitions.length ? transitions.join(" | ") : "无状态迁移",
    knowledgeRefsUsed: [],
  });
  return transitions;
}
