/**
 * Onboarding interview (PRD 13.1). Deterministic template generation of:
 * - seed identity
 * - initial world_model
 * - first-cycle candidate goal
 * Mock-LLM: no external calls; outputs are derived from the interview fields.
 */
import { storage, now } from "./storage";
import type { OnboardingInput, Project } from "@shared/schema";

const FIXED_AGENTS = [
  { name: "Orchestrator", role: "规划目标、生成预测、开方向闸" },
  { name: "Sensor", role: "导入并聚类反馈、保留原话、开意义闸" },
  { name: "Builder", role: "产出任务规格、接收构建报告" },
  { name: "Distiller", role: "从误差与反馈提炼知识候选" },
  { name: "Librarian", role: "知识库整理、状态迁移、晋级与隔离" },
];

export function generateSeed(input: OnboardingInput) {
  const seedIdentity =
    `身份:${input.name} —— ${input.oneLiner}\n` +
    `目标用户:${input.targetUser}\n` +
    `创始人偏好:${input.founderPreference || "未指定"}\n` +
    `绝不做:${input.neverDo || "未指定"}\n` +
    `红线:${input.redlines.length ? input.redlines.join("、") : "未指定"}`;

  const worldModel =
    `初始假设:${input.currentHypothesis}\n` +
    `已知竞品:${input.competitors || "未指定"}\n` +
    `反馈来源:${input.feedbackSources || "未指定"}\n` +
    `第一轮希望看到的信号:${input.firstSignal}`;

  const firstGoal = `验证核心假设:${input.currentHypothesis}(目标信号:${input.firstSignal})`;

  return { seedIdentity, worldModel, firstGoal };
}

export function createProjectFromOnboarding(input: OnboardingInput): Project {
  const id = `proj_${Date.now().toString(36)}`;
  const { seedIdentity, worldModel, firstGoal } = generateSeed(input);

  const project = storage.createProject({
    id, name: input.name, direction: input.oneLiner, targetUser: input.targetUser,
    redlines: JSON.stringify(input.redlines), weeklyHumanMinutes: input.weeklyHumanMinutes,
    seedIdentity, worldModel, currentCycleIdx: 0, version: 1,
  });

  // 5 fixed agents
  for (const a of FIXED_AGENTS) {
    storage.createAgent({ id: `agent_${a.name.toLowerCase()}_${id.slice(-4)}`, projectId: id, name: a.name, role: a.role });
  }

  // mock LLM call recorded for onboarding distillation
  storage.recordLlmCall({
    cycleId: "onboarding", agent: "orchestrator", promptVersion: "onboarding@v1",
    inputSummary: `interview: ${input.oneLiner}`, outputSummary: `seed identity + world model + first goal`,
    schemaValid: 1, retryCount: 0, latencyMs: 80, tokenCount: 320, estimatedCost: 0.00064, ts: now(),
  });

  // seed identity + world_model as initial knowledge items
  storage.createKnowledge({
    id: `kb_seed_identity_${id.slice(-4)}`, projectId: id, type: "identity",
    title: "种子身份", content: seedIdentity, sourceType: "human_decision", sourceRef: "onboarding",
    evidenceAlpha: 4, evidenceBeta: 1, confidenceScore: 0.8, confidenceLevel: "high",
    status: "active", humanApprovedCount: 1, externalVerifiedCount: 0,
    validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 0, createdByCycle: 0,
    createdBy: "owner", approvedBy: "owner", usageCount: 0,
    tags: JSON.stringify(["identity", "seed"]), notes: "onboarding 生成", version: 1,
  });
  storage.createKnowledge({
    id: `kb_seed_world_${id.slice(-4)}`, projectId: id, type: "world_model",
    title: "初始世界模型", content: worldModel, sourceType: "human_decision", sourceRef: "onboarding",
    evidenceAlpha: 2, evidenceBeta: 1, confidenceScore: 0.667, confidenceLevel: "medium",
    status: "active", humanApprovedCount: 1, externalVerifiedCount: 0,
    validFrom: now().slice(0, 10), validUntil: null, lastValidatedCycle: 0, createdByCycle: 0,
    createdBy: "owner", approvedBy: "owner", usageCount: 0,
    tags: JSON.stringify(["world_model", "seed"]), notes: "onboarding 生成", version: 1,
  });

  // first-cycle candidate goal -> create cycle 1 in planning
  storage.createCycle({
    id: `cycle_1_${id.slice(-4)}`, projectId: id, idx: 1, goal: firstGoal, status: "planning",
    eCycle: null, worstClaimError: null, reasoning: "由 onboarding seed 生成的第一轮候选目标", version: 1,
  });
  storage.updateProject(id, { currentCycleIdx: 1 });

  storage.recordEvent({ cycleIdx: 0, actor: "owner", tableName: "projects", op: "insert", before: null, after: JSON.stringify({ id, name: input.name }), ts: now() });

  return project;
}
