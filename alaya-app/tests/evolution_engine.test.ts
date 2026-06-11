import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-evolution-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { generateNextGoal } = await import("../server/autonomousGoal.ts");
const { computeSemanticKey, isContradiction, isSemanticDuplicate } = await import("../server/knowledgeSimilarity.ts");
const {
  detectGoalRepetition,
  detectKnowledgeExplosion,
  detectKnowledgeMaturationStall,
  detectPredictionStagnation,
} = await import("../server/stallGuard.ts");
const { buildNextGoalInput, runFullCycle, runLibrarian, SCENARIO } = await import("../server/flywheel.ts");
const { schedulerTickProject } = await import("../server/scheduler.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { eligibleForHighRisk } = await import("alaya-core/src/core/transition_state.ts");

const gateService = new HumanGateService(storage);

function createProject(projectId: string, currentCycleIdx = 1) {
  storage.createProject({
    id: projectId,
    name: `Evolution ${projectId}`,
    direction: "Build an autonomous learning flywheel",
    targetUser: "owner operators",
    redlines: JSON.stringify(["no irreversible action without preview"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Alaya keeps high-risk action governance auditable",
    worldModel: "Users adopt autonomous agents when preview, rollback and audit are explicit.",
    currentCycleIdx,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number, status = "planning", eCycle: number | null = null) {
  const suffix = projectId.replace(/[^a-zA-Z0-9_]+/g, "_");
  return storage.createCycle({
    id: `cycle_${idx}_${suffix}`,
    projectId,
    idx,
    goal: `cycle ${idx} goal`,
    status,
    eCycle,
    worstClaimError: eCycle,
    reasoning: "",
    version: 1,
  });
}

function createKnowledge(projectId: string, id: string, overrides: Record<string, unknown> = {}) {
  const title = String(overrides.title ?? "高风险动作必须具备 dry-run 预览");
  const content = String(overrides.content ?? "用户面对高风险自动操作时需要预览、回滚和审计摘要。");
  return storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title,
    content,
    sourceType: "metric",
    sourceRef: "test",
    evidenceAlpha: 5,
    evidenceBeta: 1,
    confidenceScore: 5 / 6,
    confidenceLevel: "high",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: 4,
    createdByCycle: 4,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["preview", "rollback", "auditability", "high_risk"]),
    notes: "",
    semanticKey: computeSemanticKey(title, content),
    supersededBy: null,
    version: 1,
    ...overrides,
  });
}

function approveDistillerProposalGates(projectId: string, cycleId: string) {
  for (const gate of storage.listGates(projectId).filter((item) => item.cycleId === cycleId && item.status === "pending" && item.type === "meaning")) {
    const payload = JSON.parse(gate.payload);
    if (payload.source !== "distiller_proposal") continue;
    gateService.approve(gate.id, { actor: "test", via: "test" });
  }
}

function measurablePrediction(cycleId: string, error = 0.6) {
  storage.createPrediction({
    id: `pred_${cycleId}`,
    cycleId,
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    claims: JSON.stringify([{
      id: "claim_activation",
      type: "metric_threshold",
      metric: "activation_rate",
      operator: ">=",
      target: 0.3,
      observed: 0.12,
      scale: 0.3,
      weight: 3,
      expectedObservation: "activation_rate >= 0.3",
      timeWindow: "cycle_feedback_window",
      successThreshold: "activation_rate >= 0.3",
      failureThreshold: "activation_rate < 0.3",
      uncertainty: 0.3,
      error,
    }]),
    observation: "activation_rate = 0.12",
    predictionError: error,
    worstClaimError: error,
    errorType: "model",
    updateTarget: "distiller_world_model_update",
    status: "resolved",
    knowledgeRefs: "[]",
  });
}

test("autonomousGoal is deterministic, references eligible knowledge and avoids rejected repeats", async () => {
  const projectId = "proj_auto_goal_a101";
  createProject(projectId);
  const cycle = createCycle(projectId, 5);
  createKnowledge(projectId, "kb_goal_1", { status: "strong", humanApprovedCount: 1 });
  createKnowledge(projectId, "kb_goal_dirty", { status: "quarantined" });
  const input = buildNextGoalInput(projectId, 5, cycle.id);

  assert.deepEqual(input.eligibleKnowledge.map((item) => item.id), ["kb_goal_1"]);
  const first = await generateNextGoal(input);
  const second = await generateNextGoal(input);
  assert.deepEqual(second, first);
  assert.ok(first.referencedKnowledgeIds.includes("kb_goal_1"));
  assert.match(first.reasoningHowKnowledgeChangedDecision, /kb_goal_1/);
  assert.equal(first.proposedGoal.length > 0, true);

  const repeatedLlm = async () => ({
    proposedGoal: first.proposedGoal,
    belief: first.belief,
    prediction: first.prediction,
    action: first.action,
    alternativeGoals: [],
    referencedKnowledgeIds: ["kb_goal_1"],
    reasoningHowKnowledgeChangedDecision: "引用 kb_goal_1: 这个重复目标应被拒绝并回退到确定性候选。",
  });
  const recovered = await generateNextGoal({ ...input, rejectedGoals: [first.proposedGoal] }, repeatedLlm as any);
  assert.notEqual(recovered.proposedGoal, first.proposedGoal);
  assert.ok(!recovered.referencedKnowledgeIds.includes("kb_goal_dirty"));
});

test("autonomousGoal still calls LLM after deterministic themes are exhausted", async () => {
  const projectId = "proj_auto_goal_exhausted_a102";
  createProject(projectId);
  const cycle = createCycle(projectId, 51);
  createKnowledge(projectId, "kb_goal_exhausted", { status: "strong", humanApprovedCount: 1 });
  const input = buildNextGoalInput(projectId, 51, cycle.id);
  const rejectedGoals: string[] = [];

  for (let i = 0; i < 18; i += 1) {
    const draft = await generateNextGoal({ ...input, cycleIndex: 5 + i, rejectedGoals });
    rejectedGoals.push(draft.proposedGoal);
  }

  let called = false;
  const llmDraft = async () => {
    called = true;
    return {
      proposedGoal: "验证医疗证据链的人审恢复路径",
      belief: "知识库显示高风险决策需要把人工复核结果转成可引用证据。",
      prediction: {
        statement: "medical_review_recovery_rate >= 0.86",
        metric: "medical_review_recovery_rate",
        operator: ">=",
        target: 0.86,
      },
      action: "把人工复核后的医疗证据链写入下一轮可引用目标生成上下文",
      alternativeGoals: ["只记录审批结果", "跳过复核继续执行"],
      referencedKnowledgeIds: ["kb_goal_exhausted"],
      reasoningHowKnowledgeChangedDecision: "引用 kb_goal_exhausted: 人工复核结果必须转成下一轮可引用证据, 所以本轮验证批准后的恢复路径。",
    };
  };

  const recovered = await generateNextGoal({ ...input, rejectedGoals }, llmDraft as any);
  assert.equal(called, true);
  assert.equal(recovered.proposedGoal, "验证医疗证据链的人审恢复路径");
  assert.deepEqual(recovered.referencedKnowledgeIds, ["kb_goal_exhausted"]);
});

test("autonomousGoal creates recovery draft when LLM and fallback goals repeat", async () => {
  const projectId = "proj_auto_goal_recovery_a103";
  createProject(projectId);
  const cycle = createCycle(projectId, 30);
  createKnowledge(projectId, "kb_goal_recovery", { status: "strong", humanApprovedCount: 1 });
  const input = buildNextGoalInput(projectId, 30, cycle.id);
  const rejectedGoals = [
    "把可回滚审计扩展到批量发布前检查",
    "为团队协作审批添加差异预览和 owner 确认",
    "把高风险动作审计摘要接入每周复盘报告",
    "为外部反馈建立自动风险标签和人工复核队列",
    "为删除类动作增加可撤销保留期和审计导出",
    "把 dry-run 预览迁移到权限变更流程",
    "建立高风险任务的最小可执行审计模板",
    "对重复低价值人工闸做合并建议",
    "为高风险自动化输出用户可理解的影响摘要",
    "把回滚触发条件变成可计算指标",
    "对沉淀知识做近义合并和来源保全",
    "为强知识冲突建立人工裁决入口",
    "把高风险知识检索默认排除 stale 和 superseded",
    "为长期飞轮输出停滞证据摘要",
    "把用户恐惧反馈映射为可验证产品约束",
    "为下一轮行动生成反事实备选和拒绝记录",
    "验证审计摘要能否帮助 owner 降低复盘时间",
    "为高风险动作建立执行前知识引用证明",
    "把重复反馈自动合并后的抽样复核变成指标（第30轮·批次3）",
  ];
  const repeatedLlm = async () => ({
    proposedGoal: "把重复反馈自动合并后的抽样复核变成指标（第30轮·批次3）",
    belief: "重复模板",
    prediction: {
      statement: "merged_gate_sample_accuracy >= 0.79",
      metric: "merged_gate_sample_accuracy",
      operator: ">=",
      target: 0.79,
    },
    action: "重复模板",
    alternativeGoals: [],
    referencedKnowledgeIds: ["kb_goal_recovery"],
    reasoningHowKnowledgeChangedDecision: "引用 kb_goal_recovery: 重复模板应该被恢复路径替换。",
  });

  const recovered = await generateNextGoal({ ...input, rejectedGoals }, repeatedLlm as any);
  assert.equal(detectGoalRepetition(recovered.proposedGoal, rejectedGoals), false);
  assert.match(recovered.proposedGoal, /C30|第30轮/);
  assert.deepEqual(recovered.referencedKnowledgeIds, ["kb_goal_recovery"]);
  assert.match(recovered.reasoningHowKnowledgeChangedDecision, /kb_goal_recovery/);
});

test("stallGuard detectors catch stagnation, repetition, maturation stall and explosion", () => {
  assert.equal(detectPredictionStagnation([0.6, 0.6, 0.61]), true);
  assert.equal(detectPredictionStagnation([0.6, 0.4, 0.2]), false);
  assert.equal(detectPredictionStagnation([0, 0, 0]), false);
  assert.equal(detectGoalRepetition("为删除动作增加 dry-run 预览", ["给删除动作增加预览"]), true);
  assert.equal(detectGoalRepetition("建立审计摘要周报", ["先扩大流量"]), false);
  assert.equal(detectKnowledgeMaturationStall([2, 2, 2, 2, 2]), true);
  assert.equal(detectKnowledgeMaturationStall([2, 2, 3, 3, 3]), false);
  assert.equal(detectKnowledgeExplosion([3, 5, 7, 10, 14, 19]), true);
  assert.equal(detectKnowledgeExplosion([3, 4, 4, 5, 5, 6]), false);
});

test("knowledgeSimilarity detects duplicates and contradictions", () => {
  const previewA = { title: "高风险动作必须具备 dry-run 预览", content: "执行前必须展示将改动什么。" };
  const previewB = { title: "高风险操作需要可预览差异", content: "用户要先看到影响范围才敢确认。" };
  const unrelated = { title: "视觉主题模板", content: "优化颜色和排版。" };
  const conflict = { title: "高风险动作不需要预览", content: "删除前无需展示差异。" };
  const ppgChoice = { title: "静息心率监测 PPG 优先", content: "静息心率监测应该以 PPG 为主。", semanticKey: "health_sensor_choice" };
  const ecgChoice = { title: "静息心率监测 ECG 优先", content: "静息心率监测应以 ECG 为主。", semanticKey: "health_sensor_choice" };
  assert.equal(isSemanticDuplicate(previewA, previewB, 0.55), true);
  assert.equal(isSemanticDuplicate(previewA, unrelated, 0.55), false);
  assert.equal(isContradiction(previewA, conflict), true);
  assert.equal(isContradiction(ppgChoice, ecgChoice), true);
});

test("Librarian merges near-duplicate knowledge without physical deletion and records merge audit", async () => {
  const projectId = "proj_merge_m202";
  createProject(projectId);
  const cycle = createCycle(projectId, 5, "running");
  createKnowledge(projectId, "kb_merge_a", {
    title: "高风险动作必须具备 dry-run 预览",
    content: "执行前必须展示将改动什么,并保留审计摘要。",
    evidenceAlpha: 4,
    evidenceBeta: 1,
    confidenceScore: 0.8,
    semanticKey: "preview|risk|audit",
  });
  createKnowledge(projectId, "kb_merge_b", {
    title: "高风险操作需要可预览差异",
    content: "用户要先看到影响范围才敢确认,审计摘要必须保留。",
    evidenceAlpha: 3,
    evidenceBeta: 1,
    confidenceScore: 0.75,
    semanticKey: "preview|risk|audit",
  });

  await runLibrarian(projectId, cycle.id, {
    index: 5,
    proposedGoal: "merge test",
    alternativeGoals: [],
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    activationObserved: 0.4,
    activationTarget: 0.3,
    feedback: [],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  });

  const items = storage.listKnowledge(projectId);
  assert.equal(items.length, 2);
  const superseded = items.find((item) => item.supersededBy);
  const keeper = items.find((item) => !item.supersededBy);
  assert.ok(superseded);
  assert.ok(keeper);
  assert.equal(superseded.supersededBy, keeper.id);
  assert.equal(keeper.evidenceAlpha, 6);
  assert.equal(storage.listEvents().some((event) => event.actor === "librarian" && event.op === "merge"), true);
  assert.equal(storage.listEvents().some((event) => event.tableName === "knowledge_items" && event.op === "delete"), false);
});

test("Librarian marks contradiction with strong knowledge as conflict and high-risk ineligible", async () => {
  const projectId = "proj_conflict_c303";
  createProject(projectId);
  const cycle = createCycle(projectId, 5, "running");
  createKnowledge(projectId, "kb_strong_preview", {
    title: "高风险删除必须具备预览",
    content: "删除前必须展示差异、回滚方案和审计摘要。",
    status: "strong",
    evidenceAlpha: 8,
    evidenceBeta: 1,
    confidenceScore: 8 / 9,
    confidenceLevel: "verified",
    humanApprovedCount: 1,
    semanticKey: "preview|risk|audit",
  });
  createKnowledge(projectId, "kb_bad_preview", {
    title: "高风险删除不需要预览",
    content: "删除前无需展示差异或审计摘要。",
    status: "active",
    evidenceAlpha: 5,
    evidenceBeta: 1,
    confidenceScore: 5 / 6,
    semanticKey: "preview|risk|audit",
  });

  await runLibrarian(projectId, cycle.id, {
    index: 5,
    proposedGoal: "conflict test",
    alternativeGoals: [],
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    activationObserved: 0.4,
    activationTarget: 0.3,
    feedback: [],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  });

  const bad = storage.getKnowledge("kb_bad_preview");
  assert.equal(bad?.status, "conflict");
  assert.equal(eligibleForHighRisk({ ...(bad as any), tags: [] }), false);
});

test("Librarian does not auto-conflict onboarding seed knowledge", async () => {
  const projectId = "proj_seed_librarian_conflict_guard";
  createProject(projectId);
  const cycle = createCycle(projectId, 5, "running");
  createKnowledge(projectId, "kb_seed_identity_guard", {
    type: "identity",
    title: "种子身份",
    content: "身份:wearable-health-signal-decision。静息心率监测应该优先选用 PPG 还是 ECG？遇到 PPG vs ECG 选型矛盾必须记录 conflict 并等待人工审核。",
    sourceType: "human_decision",
    sourceRef: "onboarding",
    evidenceAlpha: 4,
    evidenceBeta: 1,
    confidenceScore: 0.8,
    status: "active",
    humanApprovedCount: 1,
    tags: JSON.stringify(["identity", "seed"]),
    semanticKey: "seed|health_sensor_choice",
    createdBy: "owner",
  });
  createKnowledge(projectId, "kb_ppg_strong_guard", {
    title: "静息心率监测 PPG 优先",
    content: "静息心率监测应该以 PPG 为主。",
    status: "strong",
    evidenceAlpha: 6,
    evidenceBeta: 1,
    confidenceScore: 6 / 7,
    confidenceLevel: "verified",
    humanApprovedCount: 1,
    semanticKey: "health_sensor_choice",
  });

  const transitions = await runLibrarian(projectId, cycle.id, {
    index: 5,
    proposedGoal: "seed conflict guard",
    alternativeGoals: [],
    belief: "belief",
    prediction: "activation_rate >= 0.3",
    action: "action",
    activationObserved: 0.4,
    activationTarget: 0.3,
    feedback: [],
    buildSuccess: true,
    perceptionOk: true,
    humanValueMismatch: false,
  });

  assert.equal(storage.getKnowledge("kb_seed_identity_guard")?.status, "active");
  assert.ok(!transitions.some((item: string) => item.includes("kb_seed_identity_guard") && item.includes("->conflict")));
});

test("scheduler creates autonomous cycle 5 instead of scenario_exhausted", async () => {
  const projectId = "proj_sched_auto_s404";
  createProject(projectId);
  let cycle = createCycle(projectId, 1);
  for (let idx = 1; idx <= SCENARIO.length; idx += 1) {
    await runFullCycle(projectId, cycle.id);
    approveDistillerProposalGates(projectId, cycle.id);
    if (idx < SCENARIO.length) {
      const sc = SCENARIO[idx];
      cycle = storage.createCycle({
        id: `cycle_${idx + 1}_${projectId.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
        projectId,
        idx: idx + 1,
        goal: sc.proposedGoal,
        status: "planning",
        eCycle: null,
        worstClaimError: null,
        reasoning: "",
        version: 1,
      });
      storage.updateProject(projectId, { currentCycleIdx: idx + 1 });
    }
  }

  const created = await schedulerTickProject(projectId);
  assert.equal(created.action, "created_next_cycle");
  const cycle5 = storage.listCycles(projectId).find((item) => item.idx === 5);
  assert.ok(cycle5);
  assert.notEqual(cycle5.goal, "");
  const opened = await schedulerTickProject(projectId);
  assert.equal(opened.action, "opened_direction_gate");
});

test("scheduler stops honestly with evolution_stalled risk gate when errors do not improve", async () => {
  const projectId = "proj_stall_stop_t505";
  createProject(projectId, 4);
  for (let idx = 1; idx <= 4; idx += 1) {
    const cycle = createCycle(projectId, idx, "closed", 0.6);
    measurablePrediction(cycle.id, 0.6);
  }
  createKnowledge(projectId, "kb_stall_anchor", { status: "strong", humanApprovedCount: 1 });

  const result = await schedulerTickProject(projectId);
  assert.equal(result.action, "safety_mode");
  assert.equal(storage.listCycles(projectId).some((cycle) => cycle.idx === 5), false);
  const gate = storage.listGates(projectId).find((item) => item.type === "risk" && item.blocking === 1);
  assert.ok(gate);
  assert.equal(JSON.parse(gate.payload).riskKey, "evolution_stalled");

  new HumanGateService(storage).approve(gate.id, {
    via: "test",
    actor: "human_test",
    rationale: "acknowledge stall risk and allow one recovery cycle",
  });
  const resumed = await schedulerTickProject(projectId);
  assert.equal(resumed.action, "created_next_cycle");
  assert.equal(storage.listCycles(projectId).some((cycle) => cycle.idx === 5), true);
});
