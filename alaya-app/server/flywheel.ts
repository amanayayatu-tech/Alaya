/**
 * Flywheel engine: ports shared/core/agents_ref.ts logic to a SQLite-backed runner.
 * Reuses the verified pure functions from shared/core (NO algorithm changes).
 * Sequentially schedules the 5 fixed agents and records every write to eventLog,
 * every "LLM call" to llmCalls (deterministic, with token/cost placeholders).
 */
import { storage, now } from "./storage";
import { computeClaimError, computeCycleError } from "@shared/core/compute_error.js";
import { classifyError, routeError } from "@shared/core/classify_error.js";
import { applyEvidence } from "@shared/core/update_confidence.js";
import { transitionState } from "@shared/core/transition_state.js";
import type { Claim, AttributionContext } from "@shared/core/types.js";
import type { KnowledgeItem } from "@shared/schema";

// Deterministic 3-round scenario (mirrors shared/core/scenario_ref.ts narrative)
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
];

// ---------------- mock LLM (deterministic) ----------------
const PROMPT_VERSION = "v1";
function mockLlm(cycleId: string, agent: string, promptName: string, inputSummary: string, outputSummary: string) {
  // deterministic token + cost placeholders derived from string lengths
  const tokenCount = 120 + inputSummary.length + outputSummary.length;
  const estimatedCost = +(tokenCount * 0.000002).toFixed(6);
  storage.recordLlmCall({
    cycleId, agent, promptVersion: `${promptName}@${PROMPT_VERSION}`,
    inputSummary, outputSummary, schemaValid: 1, retryCount: 0,
    latencyMs: 40 + (tokenCount % 60), tokenCount, estimatedCost, ts: now(),
  });
}

function logEvent(cycleIdx: number, actor: string, table: string, op: string, after: unknown) {
  storage.recordEvent({ cycleIdx, actor, tableName: table, op, before: null, after: JSON.stringify(after), ts: now() });
}

// JSON field helpers for knowledge items (DB stores tags as JSON text)
function parseTags(k: KnowledgeItem): string[] {
  try { return JSON.parse(k.tags) as string[]; } catch { return []; }
}

let kbCounter = 0;
function nextKbId(projectId: string): string {
  // count existing to keep ids stable across seed runs
  const existing = storage.listKnowledge(projectId).length;
  kbCounter = Math.max(kbCounter, existing);
  return `kb_${String(++kbCounter).padStart(3, "0")}`;
}

function activeKnowledge(projectId: string): KnowledgeItem[] {
  return storage.listKnowledge(projectId).filter((k) => ["active", "strong", "draft", "provisional"].includes(k.status));
}

// Convert core KnowledgeItem (tags: string[]) <-> DB KnowledgeItem (tags: json text)
function coreFromDb(k: KnowledgeItem) {
  return { ...k, tags: parseTags(k), validUntil: k.validUntil ?? null, approvedBy: k.approvedBy ?? null } as any;
}
function applyEvidenceDb(k: KnowledgeItem, event: any) {
  const core = coreFromDb(k);
  const r = applyEvidence(core, event);
  return r.next;
}

// ---------------- Agents ----------------
export function runOrchestrator(projectId: string, cycleId: string, sc: ScenarioRound) {
  let goal = sc.proposedGoal, belief = sc.belief, prediction = sc.prediction, action = sc.action;
  const refs: string[] = [];
  let reasoning = "";

  if (sc.index >= 3) {
    const usable = activeKnowledge(projectId);
    const previewKnowledge = usable.find((k) => parseTags(k).includes("preview"));
    const fearKnowledge = usable.find((k) => parseTags(k).includes("user_fear"));
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

  mockLlm(cycleId, "orchestrator", "plan_cycle", `cycle ${sc.index} plan`, `goal: ${goal}`);

  storage.updateCycle(cycleId, { goal, reasoning, status: "running" });
  logEvent(sc.index, "orchestrator", "cycles", "update", { cycleId, goal });

  // direction gate (PRD 11.1)
  const gate = storage.createGate({
    id: `gate_dir_${sc.index}_${projectId.slice(-4)}`,
    cycleId, type: "direction", blocking: 1,
    title: `第 ${sc.index} 轮方向闸`,
    payload: JSON.stringify({ recommended: goal, alternatives: sc.alternativeGoals, knowledgeRefs: refs, reasoning }),
    status: "pending", estimatedMinutes: 10, decision: null, version: 1,
  });
  logEvent(sc.index, "orchestrator", "human_gate_items", "insert", { gateId: gate.id });

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "orchestrator",
    action: "plan_cycle + open_direction_gate",
    outputSummary: `目标: ${goal}${refs.length ? ` | 引用知识: ${refs.join(",")}` : ""}`,
    knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
  });

  return { goal, belief, prediction, action, refs, reasoning, gate };
}

export function humanResolveDirectionGate(projectId: string, cycleId: string, gateId: string, sc: ScenarioRound) {
  storage.updateGate(gateId, { status: "approved", decision: "approve_recommended" });
  storage.createDecision({
    id: `dec_dir_${sc.index}_${projectId.slice(-4)}`, cycleId, gateType: "direction",
    decision: "approve_recommended", rationale: "推荐目标与已验证知识一致", ts: now(),
  });
  logEvent(sc.index, "human", "decision_log", "insert", { gateId, decision: "approve_recommended" });
}

export function runSensor(projectId: string, cycleId: string, sc: ScenarioRound) {
  mockLlm(cycleId, "sensor", "cluster_feedback", `${sc.feedback.length} feedback items`, "clustered + preserved quotes");
  const bugs = sc.feedback.filter((f) => f.category === "bug");
  const unclear = sc.feedback.filter((f) => f.category === "unclear_signal");

  for (const f of sc.feedback) {
    storage.createFeedback({ id: `${f.id}_${cycleId}`, cycleId, text: f.text, category: f.category, sentiment: f.sentiment });
  }
  // unclear -> meaning gate (merged by topic; single topic here)
  for (const u of unclear) {
    const gate = storage.createGate({
      id: `gate_meaning_${sc.index}_${u.id}`,
      cycleId, type: "meaning", blocking: 0,
      title: `模糊反馈意义闸: ${u.text.slice(0, 12)}...`,
      payload: JSON.stringify({ userQuote: u.text, mergedCount: 1 }),
      status: "pending", estimatedMinutes: 8, decision: null, version: 1,
    });
    logEvent(sc.index, "sensor", "human_gate_items", "insert", { gateId: gate.id });
  }

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "sensor", action: "import_and_cluster_feedback",
    outputSummary: `反馈 ${sc.feedback.length} 条 (bug ${bugs.length}, 模糊 ${unclear.length}),保留原话`,
    knowledgeRefsUsed: "[]", ts: now(),
  });
  return { unclear };
}

export function runBuilder(cycleId: string, sc: ScenarioRound) {
  mockLlm(cycleId, "builder", "emit_task_spec", sc.action, sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)");
  const task = storage.createTask({
    id: `task_${sc.index}_${cycleId.slice(-4)}`, cycleId, agent: "builder", kind: "build",
    status: sc.buildSuccess ? "done" : "failed",
    spec: JSON.stringify({ action: sc.action, diffSummary: `mock diff for: ${sc.action}`, testReport: sc.buildSuccess ? "all tests pass (mock)" : "build failed (mock)" }),
  });
  logEvent(sc.index, "builder", "tasks", "insert", { taskId: task.id, success: sc.buildSuccess });
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "builder", action: "emit_task_spec + receive_mock_build_report",
    outputSummary: `build=${sc.buildSuccess ? "成功" : "失败"} | mock diff for: ${sc.action}`,
    knowledgeRefsUsed: "[]", ts: now(),
  });
  return { buildSuccess: sc.buildSuccess };
}

export function evaluatePrediction(
  projectId: string, cycleId: string, sc: ScenarioRound,
  plan: { belief: string; prediction: string; action: string; refs: string[] },
) {
  const claim: Claim = {
    id: `claim_${sc.index}`, type: "metric_threshold", metric: "activation_rate",
    operator: ">=", target: sc.activationTarget, observed: sc.activationObserved,
    scale: sc.activationTarget, weight: 3,
  };
  claim.error = computeClaimError(claim);
  const cycleErr = computeCycleError([claim]);

  const errorType = classifyError(claim.error, {
    perceptionFailure: !sc.perceptionOk,
    executionFailure: !sc.buildSuccess,
    humanFlaggedValueMismatch: sc.humanValueMismatch,
    isQualitative: false,
  } as AttributionContext);

  const pred = storage.createPrediction({
    id: `pred_${sc.index}_${projectId.slice(-4)}`, cycleId,
    belief: plan.belief, prediction: plan.prediction, action: plan.action,
    claims: JSON.stringify([claim]),
    observation: `activation_rate = ${sc.activationObserved}`,
    predictionError: cycleErr.eCycle, worstClaimError: cycleErr.worstClaimError,
    errorType: errorType, updateTarget: routeError(errorType), status: "resolved",
    knowledgeRefs: JSON.stringify(plan.refs),
  });
  storage.createObservation({
    id: `obs_${sc.index}_${projectId.slice(-4)}`, cycleId, predictionId: pred.id,
    metric: "activation_rate", value: sc.activationObserved, source: "mock_analytics",
  });
  storage.updateCycle(cycleId, { eCycle: cycleErr.eCycle, worstClaimError: cycleErr.worstClaimError });
  logEvent(sc.index, "orchestrator", "predictions", "insert", { predId: pred.id, eCycle: cycleErr.eCycle });
  return { pred, claimError: claim.error ?? 0 };
}

export function runDistiller(projectId: string, cycleId: string, sc: ScenarioRound, claimError: number, refs: string[]) {
  mockLlm(cycleId, "distiller", "distill_knowledge", `cycle ${sc.index} error=${claimError.toFixed(2)}`, "distilled candidates");
  const created: string[] = [];

  if (sc.index === 1) {
    const base: KnowledgeItem = {
      id: nextKbId(projectId), projectId, type: "world_model",
      title: "用户对不可预期的自动操作有恐惧",
      content: "早期用户不敢用一键发布,因为不知道会改动什么。恐惧而非能力是采用门槛。",
      sourceType: "feedback", sourceRef: "f1,f2",
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
      status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
      validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 1, createdByCycle: 1,
      createdBy: "distiller", approvedBy: null, usageCount: 0,
      tags: JSON.stringify(["user_fear", "adoption"]), notes: "由第1轮预测失败 + 两条负面反馈提炼", version: 1,
    };
    const next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
    const saved = storage.createKnowledge({ ...base, evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta, confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel });
    created.push(saved.id);
    logEvent(1, "distiller", "knowledge_items", "insert", { id: saved.id });
  }

  if (sc.index === 2) {
    const k1 = storage.listKnowledge(projectId).find((k) => parseTags(k).includes("user_fear"));
    if (k1) {
      let next = applyEvidenceDb(k1, { kind: "prediction", normalizedError: claimError });
      next = applyEvidence(coreFromDb({ ...k1, ...next } as any), { kind: "external_verify" }).next as any;
      storage.updateKnowledge(k1.id, {
        evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta,
        confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel,
        externalVerifiedCount: next.externalVerifiedCount, lastValidatedCycle: 2,
      });
      logEvent(2, "distiller", "knowledge_items", "update", { id: k1.id, score: next.confidenceScore });
    }
    const base: KnowledgeItem = {
      id: nextKbId(projectId), projectId, type: "principle",
      title: "可预览/可逆显著降低高风险动作使用门槛",
      content: "为发布加 dry-run 预览后 activation 达标。预览把不可逆恐惧转为可控。",
      sourceType: "metric", sourceRef: "claim_2,f3,f4",
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low",
      status: "draft", humanApprovedCount: 0, externalVerifiedCount: 0,
      validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 2, createdByCycle: 2,
      createdBy: "distiller", approvedBy: null, usageCount: 0,
      tags: JSON.stringify(["preview", "principle", "high_risk"]), notes: "由第2轮预测成功 + 正面反馈提炼", version: 1,
    };
    const next = applyEvidenceDb(base, { kind: "prediction", normalizedError: claimError });
    const saved = storage.createKnowledge({ ...base, evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta, confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel });
    created.push(saved.id);
    logEvent(2, "distiller", "knowledge_items", "insert", { id: saved.id });
  }

  if (sc.index === 3) {
    for (const k of activeKnowledge(projectId)) {
      const tags = parseTags(k);
      if (tags.includes("preview") || tags.includes("user_fear")) {
        // accumulate enough evidence so score>=0.85 & evidenceCount>=5 to enable strong
        let next = applyEvidenceDb(k, { kind: "prediction", normalizedError: claimError });
        next = applyEvidence(coreFromDb({ ...k, ...next } as any), { kind: "human_approve" }).next as any;
        next = applyEvidence(coreFromDb({ ...k, ...next } as any), { kind: "external_verify" }).next as any;
        storage.updateKnowledge(k.id, {
          evidenceAlpha: next.evidenceAlpha, evidenceBeta: next.evidenceBeta,
          confidenceScore: next.confidenceScore, confidenceLevel: next.confidenceLevel,
          humanApprovedCount: next.humanApprovedCount, externalVerifiedCount: next.externalVerifiedCount,
          approvedBy: "owner", lastValidatedCycle: 3, usageCount: k.usageCount + 1,
        });
        logEvent(3, "distiller", "knowledge_items", "update", { id: k.id, score: next.confidenceScore });
      }
    }
  }

  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "distiller", action: "distill_knowledge_candidates",
    outputSummary: created.length ? `生成知识候选: ${created.join(",")}` : "强化既有知识证据",
    knowledgeRefsUsed: JSON.stringify(refs), ts: now(),
  });
  return created;
}

export function runLibrarian(projectId: string, cycleId: string, sc: ScenarioRound) {
  mockLlm(cycleId, "librarian", "audit_and_merge", "incremental audit", "transitions computed");
  const transitions: string[] = [];
  for (const k of storage.listKnowledge(projectId)) {
    const core = coreFromDb(k);
    const r = transitionState(core, {
      currentCycle: sc.index, conflictsWithStrong: false,
      humanApprovedStrongPromotion: k.humanApprovedCount >= 1,
    });
    if (r.changed) {
      storage.updateKnowledge(k.id, { status: r.nextStatus });
      transitions.push(`${k.id}: ${k.status}->${r.nextStatus} (${r.reason})`);
      logEvent(sc.index, "librarian", "knowledge_items", "transition", { id: k.id, from: k.status, to: r.nextStatus });
    }
  }
  storage.recordAgentRun({
    cycleId, cycleIdx: sc.index, agent: "librarian", action: "audit_merge_transition",
    outputSummary: transitions.length ? transitions.join(" | ") : "无状态迁移",
    knowledgeRefsUsed: "[]", ts: now(),
  });
  return transitions;
}

// ---------------- run-full: one complete flywheel turn ----------------
export function runFullCycle(projectId: string, cycleId: string) {
  const cycle = storage.getCycle(cycleId);
  if (!cycle) throw new Error("cycle not found");
  const sc = SCENARIO.find((s) => s.index === cycle.idx) ?? SCENARIO[SCENARIO.length - 1];

  const plan = runOrchestrator(projectId, cycleId, sc);
  humanResolveDirectionGate(projectId, cycleId, plan.gate.id, sc);
  runSensor(projectId, cycleId, sc);
  runBuilder(cycleId, sc);
  const { pred, claimError } = evaluatePrediction(projectId, cycleId, sc, plan);
  runDistiller(projectId, cycleId, sc, claimError, plan.refs);
  const transitions = runLibrarian(projectId, cycleId, sc);

  storage.updateCycle(cycleId, { status: "closed" });
  logEvent(sc.index, "orchestrator", "cycles", "close", { cycleId });

  return { cycleIdx: sc.index, prediction: pred, transitions };
}
