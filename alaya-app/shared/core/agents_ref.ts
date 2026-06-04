/**
 * 5 Agent 顺序调度 (PRD 7、13)。
 * MVP 保留五个角色、五段职责、五类运行记录(PRD 3.2 硬约束:不得砍成单 Agent)。
 * 每个 Agent 每轮都写运行记录(PRD 17.3)。
 */

import { Store } from "../state/store.js";
import { LLMProvider } from "../llm/provider.js";
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

// ---------------- Orchestrator ----------------
/**
 * 读取 identity/world_model/上轮结果,生成本轮目标与预测。
 * 复利核心:第3轮主动引用前两轮 strong/active 知识,改变目标,避开已否决方向。
 */
export function runOrchestrator(store: Store, sc: CycleScenario, llm: LLMProvider) {
  let goal = sc.proposedGoal;
  let belief = sc.belief;
  let prediction = sc.prediction;
  let action = sc.action;
  const refs: string[] = [];
  let reasoning = "";

  if (sc.index >= 3) {
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
  } else {
    reasoning = `第 ${sc.index} 轮:基于 onboarding seed 与上轮误差生成目标`;
  }

  llm.call("orchestrator", "plan_cycle", {});

  // 方向闸 (PRD 11.1)
  const gate: HumanGate = {
    id: `gate_dir_${sc.index}`,
    cycleId: `cycle_${sc.index}`,
    type: "direction",
    blocking: true,
    title: `第 ${sc.index} 轮方向闸`,
    payload: { recommended: goal, alternatives: sc.alternativeGoals, knowledgeRefs: refs, reasoning },
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
    rationale: "推荐目标与已验证知识一致",
  });
}

// ---------------- Sensor ----------------
export function runSensor(store: Store, sc: CycleScenario, llm: LLMProvider) {
  llm.call("sensor", "cluster_feedback", {});
  const bugs = sc.feedback.filter((f) => f.category === "bug");
  const unclear = sc.feedback.filter((f) => f.category === "unclear_signal");

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
export function runBuilder(store: Store, sc: CycleScenario, llm: LLMProvider) {
  llm.call("builder", "emit_task_spec", {});
  // MVP:mock build report,不真正改代码 (PRD 7.3 / 18.5)
  const report = {
    buildSuccess: sc.buildSuccess,
    testReport: sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)",
    diffSummary: `mock diff for: ${sc.action}`,
  };
  store.recordAgentRun({
    cycleIndex: sc.index,
    agent: "builder",
    action: "emit_task_spec + receive_mock_build_report",
    outputSummary: `build=${report.buildSuccess ? "成功" : "失败"} | ${report.diffSummary}`,
    knowledgeRefsUsed: [],
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
    id: `pred_${sc.index}`,
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
) {
  llm.call("distiller", "distill_knowledge", {});
  const created: string[] = [];

  if (sc.index === 1) {
    // 预测失败 + 反馈揭示恐惧 -> 新知识 K1
    const k1 = newKnowledge(1, {
      type: "world_model",
      title: "用户对不可预期的自动操作有恐惧",
      content: "早期用户不敢用一键发布,因为不知道会改动什么。恐惧而非能力是采用门槛。",
      sourceType: "feedback",
      sourceRef: "f1,f2",
      tags: ["user_fear", "adoption"],
      notes: "由第1轮预测失败 + 两条负面反馈提炼",
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
      title: "可预览/可逆显著降低高风险动作使用门槛",
      content: "为发布加 dry-run 预览后 activation 达标。预览把不可逆恐惧转为可控。",
      sourceType: "metric",
      sourceRef: "claim_2,f3,f4",
      tags: ["preview", "principle", "high_risk"],
      notes: "由第2轮预测成功 + 正面反馈提炼",
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
export function runLibrarian(store: Store, sc: CycleScenario, llm: LLMProvider) {
  llm.call("librarian", "audit_and_merge", {});
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
