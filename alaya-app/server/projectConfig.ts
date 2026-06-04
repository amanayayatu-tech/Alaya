import { storage, now } from "./storage";
import type { KnowledgeItem, Project } from "@shared/schema";

function parseTags(value: string): string[] {
  try {
    return JSON.parse(value) as string[];
  } catch {
    return [];
  }
}

function seedKnowledge(projectId: string, type: KnowledgeItem["type"], title: string) {
  return storage.listKnowledge(projectId).find((item) => (
    item.type === type &&
    item.sourceRef === "onboarding" &&
    parseTags(item.tags).includes("seed") &&
    item.title === title
  ));
}

function baseSeedKnowledge(project: Project, type: "identity" | "world_model", title: string, content: string): KnowledgeItem {
  return {
    id: `kb_seed_${type === "identity" ? "identity" : "world"}_${project.id.slice(-4)}`,
    projectId: project.id,
    type,
    title,
    content,
    sourceType: "human_decision",
    sourceRef: "onboarding",
    evidenceAlpha: type === "identity" ? 4 : 2,
    evidenceBeta: 1,
    confidenceScore: type === "identity" ? 0.8 : 0.667,
    confidenceLevel: type === "identity" ? "high" : "medium",
    status: "active",
    humanApprovedCount: 1,
    externalVerifiedCount: 0,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 0,
    createdByCycle: 0,
    createdBy: "owner",
    approvedBy: "owner",
    usageCount: 0,
    tags: JSON.stringify(type === "identity" ? ["identity", "seed"] : ["world_model", "seed"]),
    notes: "project setup 人工校准同步",
    version: 1,
  };
}

function upsertSeedKnowledge(project: Project, type: "identity" | "world_model", title: string, content: string) {
  const existing = seedKnowledge(project.id, type, title);
  if (existing) {
    if (existing.content === content) return existing;
    return storage.updateKnowledge(existing.id, {
      content,
      sourceType: "human_decision",
      sourceRef: "onboarding",
      approvedBy: "owner",
      actor: "human",
      lastValidatedCycle: project.currentCycleIdx,
      notes: "project setup 人工校准同步",
    });
  }
  return storage.createKnowledge(baseSeedKnowledge(project, type, title, content));
}

export function syncProjectSeedKnowledge(project: Project) {
  upsertSeedKnowledge(project, "identity", "种子身份", project.seedIdentity);
  upsertSeedKnowledge(project, "world_model", "初始世界模型", project.worldModel);
}

export function updateProjectConfig(projectId: string, patch: Partial<Project>): Project | undefined {
  const project = storage.updateProject(projectId, patch);
  if (!project) return undefined;
  if ("seedIdentity" in patch || "worldModel" in patch) {
    syncProjectSeedKnowledge(project);
  }
  return project;
}
