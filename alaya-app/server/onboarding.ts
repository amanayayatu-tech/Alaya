/**
 * Onboarding interview (PRD 13.1). LLM-backed generation of:
 * - seed identity
 * - initial world_model
 * - first-cycle candidate goal
 * Mock provider remains deterministic; OpenAI-compatible provider can rewrite the seed.
 */
import { storage, now } from "./storage";
import type { OnboardingInput, Project } from "@shared/schema";
import { callLlm } from "./llm";

type OnboardingLlmCaller = typeof callLlm;

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
    `第一轮希望看到的信号:${input.firstSignal}\n` +
    `第一轮可观测指标:${input.firstClaimMetric} ${input.firstClaimOperator} ${input.firstClaimTarget}`;

  const firstGoal = `验证核心假设:${input.currentHypothesis}(目标信号:${input.firstSignal})`;

  return { seedIdentity, worldModel, firstGoal };
}

function withGeneratedNote(requiredBlock: string, generated: unknown): string {
  const text = typeof generated === "string" ? generated.trim() : "";
  if (!text || text === requiredBlock.trim()) return requiredBlock;
  return `${requiredBlock}\n\nLLM补充:\n${text}`;
}

export async function createProjectFromOnboarding(input: OnboardingInput, llmCaller: OnboardingLlmCaller = callLlm): Promise<Project> {
  const id = `proj_${Date.now().toString(36)}`;
  const fallback = generateSeed(input);
  const seed = await llmCaller({
    cycleId: "onboarding",
    agent: "orchestrator",
    promptName: "onboarding_seed",
    inputSummary: `interview: ${input.oneLiner}`,
    context: {
      name: input.name,
      oneLiner: input.oneLiner,
      targetUser: input.targetUser,
      currentHypothesis: input.currentHypothesis,
      neverDo: input.neverDo,
      redlines: input.redlines,
      founderPreference: input.founderPreference,
      competitors: input.competitors,
      feedbackSources: input.feedbackSources,
      weeklyHumanMinutes: input.weeklyHumanMinutes,
      weeklyLlmBudgetCents: input.weeklyLlmBudgetCents,
      firstClaimMetric: input.firstClaimMetric,
      firstClaimOperator: input.firstClaimOperator,
      firstClaimTarget: input.firstClaimTarget,
      firstSignal: input.firstSignal,
    },
    schema: {
      type: "object",
      required: ["summary", "seedIdentity", "worldModel", "firstGoal"],
      additionalProperties: true,
      properties: {
        summary: { type: "string" },
        seedIdentity: { type: "string" },
        worldModel: { type: "string" },
        firstGoal: { type: "string" },
      },
    },
    mockOutput: { summary: "seed identity + world model + first goal", ...fallback },
  });
  const seedIdentity = withGeneratedNote(fallback.seedIdentity, seed.seedIdentity);
  const worldModel = withGeneratedNote(fallback.worldModel, seed.worldModel);
  const firstGoal = typeof seed.firstGoal === "string" ? seed.firstGoal : fallback.firstGoal;

  const project = storage.createProject({
    id, name: input.name, direction: input.oneLiner, targetUser: input.targetUser,
    redlines: JSON.stringify(input.redlines), weeklyHumanMinutes: input.weeklyHumanMinutes,
    weeklyLlmBudgetCents: input.weeklyLlmBudgetCents,
    firstClaimMetric: input.firstClaimMetric,
    firstClaimOperator: input.firstClaimOperator,
    firstClaimTarget: input.firstClaimTarget,
    seedIdentity, worldModel, currentCycleIdx: 0, version: 1,
  });

  // 5 fixed agents
  for (const a of FIXED_AGENTS) {
    storage.createAgent({ id: `agent_${a.name.toLowerCase()}_${id.slice(-4)}`, projectId: id, name: a.name, role: a.role });
  }

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
