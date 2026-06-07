import { z } from "zod";
import type { OrgModule } from "@shared/schema";
import { storage, now } from "./storage";
import { recordTrace } from "./trace";

const listSchema = z.array(z.string().trim().min(1).max(500)).max(100).default([]);

export const orgModuleInputSchema = z.object({
  moduleName: z.string().trim().min(1).max(160),
  problemSolved: z.string().trim().max(4000).default(""),
  ownerRole: z.string().trim().max(300).default(""),
  responsibilityBoundaries: listSchema,
  upstreamDependencies: listSchema,
  downstreamConsumers: listSchema,
  dataInputs: listSchema,
  dataOutputs: listSchema,
  callChain: listSchema,
  mvpDefinition: z.string().trim().max(4000).default(""),
  testPlan: z.string().trim().max(4000).default(""),
  executionPlan: z.string().trim().max(4000).default(""),
  knownPitfalls: listSchema,
  redlines: listSchema,
  version: z.string().trim().min(1).max(80).default("v1"),
}).strict();

export type OrgModuleInput = z.infer<typeof orgModuleInputSchema>;

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "module";
}

function moduleId(projectId: string, name: string): string {
  return `org_${projectId.slice(-6)}_${slug(name)}`;
}

function jsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function bullet(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (empty)";
}

export function parseOrgModule(module: OrgModule) {
  return {
    ...module,
    responsibilityBoundaries: jsonList(module.responsibilityBoundaries),
    upstreamDependencies: jsonList(module.upstreamDependencies),
    downstreamConsumers: jsonList(module.downstreamConsumers),
    dataInputs: jsonList(module.dataInputs),
    dataOutputs: jsonList(module.dataOutputs),
    callChain: jsonList(module.callChain),
    knownPitfalls: jsonList(module.knownPitfalls),
    redlines: jsonList(module.redlines),
  };
}

export function createOrgModule(projectId: string, input: OrgModuleInput): OrgModule {
  const parsed = orgModuleInputSchema.parse(input);
  const timestamp = now();
  return storage.createOrgModule({
    id: moduleId(projectId, parsed.moduleName),
    projectId,
    moduleName: parsed.moduleName,
    problemSolved: parsed.problemSolved,
    ownerRole: parsed.ownerRole,
    responsibilityBoundaries: JSON.stringify(parsed.responsibilityBoundaries),
    upstreamDependencies: JSON.stringify(parsed.upstreamDependencies),
    downstreamConsumers: JSON.stringify(parsed.downstreamConsumers),
    dataInputs: JSON.stringify(parsed.dataInputs),
    dataOutputs: JSON.stringify(parsed.dataOutputs),
    callChain: JSON.stringify(parsed.callChain),
    mvpDefinition: parsed.mvpDefinition,
    testPlan: parsed.testPlan,
    executionPlan: parsed.executionPlan,
    knownPitfalls: JSON.stringify(parsed.knownPitfalls),
    redlines: JSON.stringify(parsed.redlines),
    versionLabel: parsed.version,
    knowledgeId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  });
}

export function updateOrgModule(id: string, input: Partial<OrgModuleInput>): OrgModule | undefined {
  const existing = storage.getOrgModule(id);
  if (!existing) return undefined;
  const current = parseOrgModule(existing);
  const parsed = orgModuleInputSchema.partial().parse(input);
  return storage.updateOrgModule(id, {
    moduleName: parsed.moduleName ?? existing.moduleName,
    problemSolved: parsed.problemSolved ?? existing.problemSolved,
    ownerRole: parsed.ownerRole ?? existing.ownerRole,
    responsibilityBoundaries: JSON.stringify(parsed.responsibilityBoundaries ?? current.responsibilityBoundaries),
    upstreamDependencies: JSON.stringify(parsed.upstreamDependencies ?? current.upstreamDependencies),
    downstreamConsumers: JSON.stringify(parsed.downstreamConsumers ?? current.downstreamConsumers),
    dataInputs: JSON.stringify(parsed.dataInputs ?? current.dataInputs),
    dataOutputs: JSON.stringify(parsed.dataOutputs ?? current.dataOutputs),
    callChain: JSON.stringify(parsed.callChain ?? current.callChain),
    mvpDefinition: parsed.mvpDefinition ?? existing.mvpDefinition,
    testPlan: parsed.testPlan ?? existing.testPlan,
    executionPlan: parsed.executionPlan ?? existing.executionPlan,
    knownPitfalls: JSON.stringify(parsed.knownPitfalls ?? current.knownPitfalls),
    redlines: JSON.stringify(parsed.redlines ?? current.redlines),
    versionLabel: parsed.version ?? existing.versionLabel,
    updatedAt: now(),
  });
}

export function orgModuleMarkdown(module: OrgModule): string {
  const parsed = parseOrgModule(module);
  return [
    `# ${parsed.moduleName}`,
    "",
    `Version: ${parsed.versionLabel}`,
    "",
    "## Problem Solved",
    parsed.problemSolved || "(empty)",
    "",
    "## Owner Role",
    parsed.ownerRole || "(empty)",
    "",
    "## Responsibility Boundaries",
    bullet(parsed.responsibilityBoundaries),
    "",
    "## Upstream Dependencies",
    bullet(parsed.upstreamDependencies),
    "",
    "## Downstream Consumers",
    bullet(parsed.downstreamConsumers),
    "",
    "## Data Inputs",
    bullet(parsed.dataInputs),
    "",
    "## Data Outputs",
    bullet(parsed.dataOutputs),
    "",
    "## Call Chain",
    bullet(parsed.callChain),
    "",
    "## MVP Definition",
    parsed.mvpDefinition || "(empty)",
    "",
    "## Test Plan",
    parsed.testPlan || "(empty)",
    "",
    "## Execution Plan",
    parsed.executionPlan || "(empty)",
    "",
    "## Known Pitfalls",
    bullet(parsed.knownPitfalls),
    "",
    "## Redlines",
    bullet(parsed.redlines),
    "",
  ].join("\n");
}

export function convertOrgModuleToKnowledge(moduleIdInput: string) {
  const module = storage.getOrgModule(moduleIdInput);
  if (!module) throw new Error(`org module not found: ${moduleIdInput}`);
  if (module.knowledgeId) {
    const existing = storage.getKnowledge(module.knowledgeId);
    if (existing) return existing;
  }
  const knowledgeId = `kb_org_${module.id.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
  const knowledge = storage.createKnowledge({
    id: knowledgeId,
    projectId: module.projectId,
    type: "playbook",
    title: `Org module: ${module.moduleName} (${module.versionLabel})`,
    content: orgModuleMarkdown(module),
    sourceType: "external_doc",
    sourceRef: `org_module:${module.id}:${module.versionLabel}`,
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "draft",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 0,
    createdByCycle: 0,
    createdBy: "org_module",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: null,
    lastVerifiedAt: null,
    lastDecayedAt: null,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: null,
    tags: JSON.stringify(["org_module", `module:${module.moduleName}`, `version:${module.versionLabel}`]),
    notes: "Converted from organization module template. Draft status prevents automatic operational injection until approved.",
    supersededBy: null,
    semanticKey: `org_module:${slug(module.moduleName)}:${module.versionLabel}`,
    version: 1,
  });
  storage.updateOrgModule(module.id, { knowledgeId, updatedAt: now() });
  recordTrace({
    projectId: module.projectId,
    cycleId: null,
    cycleIdx: null,
    kind: "principle_transition",
    name: "org_module_to_knowledge",
    agent: "owner",
    attributes: {
      orgModuleId: module.id,
      knowledgeId,
      status: "draft",
      provenance: knowledge.sourceRef,
    },
  });
  return knowledge;
}
