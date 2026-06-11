import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import { z } from "zod";
import type { Server } from "node:http";
import { buildHealthz, buildReadyz } from "./observability/health";
import { buildMetricsSnapshot, renderPrometheusMetrics } from "./observability/metrics";
import { isLongRunMode, runModeFromEnv } from "./config/env";
import { apiAuthMiddleware, metricsAccessMiddleware } from "./security/auth";
import { auditCapabilityDecision, evaluateCapability, type CapabilityName } from "./security/capabilities";
import { costEndpointRateLimit } from "./security/http";
import { storage, now } from "./storage";
import type { KnowledgeItem } from "@shared/schema";
import { claimSchema, onboardingSchema, operatorSchema } from "@shared/schema";
import { createProjectFromOnboarding } from "./onboarding";
import { updateProjectConfig } from "./projectConfig";
import { HumanGateService, type GateDecisionAction } from "./humanGateService";
import { runFullCycle, scenarioForCycle } from "./flywheel";
import {
  gateBudgetForProject,
  gateWebUrl,
  getNotificationBus,
  llmBudgetForProject,
  notificationBaseUrl,
  schedulerTickAllProjects,
  schedulerTickProject,
} from "./scheduler";
import { ingestFormFeedback, syncConfiguredFeedbackForProject, syncGithubIssuesForSource, upsertGithubSource } from "./externalFeedback";
import { seedDemo } from "./seed";
import { buildFlywheelHealth } from "./flywheelHealth";
import { parseTraceEvent } from "./trace";
import { detectKnowledgeConflicts, createKnowledgeReviewReminders, resolveKnowledgeReview } from "./knowledgeReview";
import { formatGateDecisionReceiptText, formatGateDecisionRequestText, knowledgeIdForMeaningGate } from "./notifications/gateNarrative";
import { CodexCliBuilderAdapter } from "./builderAdapter";
import { runProviderCanary } from "./providerCanary";
import { buildOpsMetrics } from "./opsMetrics";
import { importBusinessSignals } from "./businessSignals";
import {
  createOrgModule,
  updateOrgModule,
  orgModuleInputSchema,
  orgModuleMarkdown,
  parseOrgModule,
  convertOrgModuleToKnowledge,
} from "./orgModules";
import { applyEvidence } from "alaya-core/src/core/update_confidence.js";
import { transitionState } from "alaya-core/src/core/transition_state.js";

function parseJsonFields<T extends Record<string, any>>(obj: T, fields: string[]): T {
  const out: any = { ...obj };
  for (const f of fields) {
    if (typeof out[f] === "string") {
      try {
        out[f] = JSON.parse(out[f]);
      } catch {
        console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", source: "routes", message: "json field parse failed", field: f }));
      }
    }
  }
  return out;
}

const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

function rejectDangerousMarkup(value: string): boolean {
  return !/<\s*script\b/i.test(value) && !/\bjavascript\s*:/i.test(value);
}

const idSchema = z.string().trim().min(1).max(160).regex(ID_RE);
const shortTextSchema = z.string().trim().min(1).max(500).refine(rejectDangerousMarkup, "dangerous markup is not allowed");
const longTextSchema = z.string().trim().max(10_000).refine(rejectDangerousMarkup, "dangerous markup is not allowed");
const nonEmptyLongTextSchema = z.string().trim().min(1).max(10_000).refine(rejectDangerousMarkup, "dangerous markup is not allowed");
const tagSchema = z.array(z.string().trim().min(1).max(80).refine(rejectDangerousMarkup)).max(30).default([]);
const optionalNullableNumber = z.number().finite().nullable().optional();

const predictionCreateSchema = z.object({
  id: idSchema.optional(),
  cycleId: idSchema,
  belief: longTextSchema.default(""),
  prediction: longTextSchema.default(""),
  action: longTextSchema.default(""),
  claims: z.array(claimSchema).max(50).default([]),
  observation: longTextSchema.nullable().optional(),
  predictionError: optionalNullableNumber,
  worstClaimError: optionalNullableNumber,
  errorType: z.enum(["perception", "execution", "model", "value"]).nullable().optional(),
  updateTarget: shortTextSchema.nullable().optional(),
  status: z.enum(["open", "resolved"]).default("open"),
  knowledgeRefs: z.array(idSchema).max(100).default([]),
}).strict();

const projectPatchSchema = z.object({
  name: shortTextSchema.optional(),
  direction: nonEmptyLongTextSchema.optional(),
  targetUser: shortTextSchema.optional(),
  redlines: z.array(z.string().trim().min(1).max(500).refine(rejectDangerousMarkup)).max(100).optional(),
  weeklyHumanMinutes: z.number().int().min(0).max(10_080).optional(),
  weeklyLlmBudgetCents: z.number().int().min(0).max(10_000_000).optional(),
  firstClaimMetric: shortTextSchema.optional(),
  firstClaimOperator: operatorSchema.optional(),
  firstClaimTarget: z.number().finite().optional(),
  seedIdentity: longTextSchema.optional(),
  worldModel: longTextSchema.optional(),
}).strict();

const predictionObservationSchema = z.object({
  observation: longTextSchema,
}).strict();

const predictionErrorSchema = z.object({
  predictionError: z.number().finite(),
  worstClaimError: optionalNullableNumber,
  errorType: z.enum(["perception", "execution", "model", "value"]).nullable().optional(),
  updateTarget: shortTextSchema.nullable().optional(),
}).strict();

const knowledgeCreateSchema = z.object({
  id: idSchema.optional(),
  projectId: idSchema,
  type: shortTextSchema.default("fact"),
  title: shortTextSchema,
  content: nonEmptyLongTextSchema,
  sourceType: shortTextSchema.default("agent_observation"),
  sourceRef: longTextSchema.default(""),
  cycleIdx: z.number().int().min(0).max(1_000_000).default(0),
  createdBy: shortTextSchema.default("distiller"),
  tags: tagSchema,
  notes: longTextSchema.default(""),
}).strict();

const knowledgePatchSchema = z.object({
  type: shortTextSchema.optional(),
  title: shortTextSchema.optional(),
  content: nonEmptyLongTextSchema.optional(),
  sourceType: shortTextSchema.optional(),
  sourceRef: longTextSchema.optional(),
  confidenceScore: z.number().finite().min(0).max(1).optional(),
  confidenceLevel: z.enum(["low", "medium", "high", "verified"]).optional(),
  status: z.enum(["draft", "active", "strong", "stale", "expired", "quarantined", "conflict", "deprecated", "rejected"]).optional(),
  humanApprovedCount: z.number().int().min(0).optional(),
  externalVerifiedCount: z.number().int().min(0).optional(),
  validFrom: z.string().trim().max(32).optional(),
  validUntil: z.string().trim().max(32).nullable().optional(),
  tags: tagSchema.optional(),
  notes: longTextSchema.optional(),
  supersededBy: idSchema.nullable().optional(),
  semanticKey: shortTextSchema.optional(),
}).strict();

const gateDecisionSchema = z.object({
  rationale: longTextSchema.default(""),
  reasonCode: z.enum(["wrong_direction", "weak_evidence", "not_now", "too_risky", "risk_too_high"]).optional(),
  reviewOpenedAt: z.union([z.string().trim().max(64), z.number().finite()]).nullable().optional(),
  deferUntil: z.string().trim().max(64).nullable().optional(),
}).passthrough();

const feedbackSyncSchema = z.object({
  token: z.string().trim().max(4096).optional(),
  githubToken: z.string().trim().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  syncFeedback: z.boolean().optional(),
  projectId: idSchema.optional(),
}).passthrough();

const knowledgeReviewResolveSchema = z.object({
  action: z.enum(["approve_as_current", "quarantine", "merge_supersede", "downgrade_to_stale", "reject_conflict"]),
  rationale: longTextSchema.default(""),
  survivorKnowledgeId: idSchema.optional(),
}).strict();

const builderPlanSchema = z.object({
  cycleId: idSchema.nullable().optional(),
  goal: nonEmptyLongTextSchema,
  repoPath: longTextSchema.optional(),
  constraints: z.array(longTextSchema).max(50).optional(),
  requestedFiles: z.array(longTextSchema).max(50).optional(),
}).strict();

const providerCanarySchema = z.object({
  cycleId: idSchema.nullable().optional(),
  provider: z.enum(["mock", "openai"]).optional(),
  model: shortTextSchema.optional(),
  role: z.enum(["orchestrator", "sensor", "builder", "distiller", "librarian"]).optional(),
  forceFailure: z.enum(["schema_error", "provider_error"]).optional(),
}).strict();

const businessSignalsImportSchema = z.object({
  rows: z.array(z.record(z.unknown())).max(500).optional(),
  signals: z.array(z.record(z.unknown())).max(500).optional(),
}).strict();

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({ message: "invalid request body", errors: error.flatten() });
}

function feedbackSyncOptions(req: Request) {
  return {
    token: req.body?.token ?? req.body?.githubToken,
    limit: req.body?.limit,
  };
}

function numericLimit(value: unknown, fallback = 1000): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 5000) : fallback;
}

function mutatingCapabilityForRequest(req: Request): CapabilityName {
  if (req.path.includes("/builder/codex/apply")) return req.body?.dryRun === false ? "shell_execution" : "knowledge_write";
  if (req.path.includes("/provider-canary")) return "llm_call";
  if (req.path.includes("/business-signals") || req.path.includes("/org-modules") || req.path.includes("/builder/codex/plan")) return "knowledge_write";
  if (req.path.includes("/scheduler")) return "scheduler_loop";
  if (req.path.includes("/seed-demo")) return "knowledge_write";
  if (req.path.includes("/knowledge")) return "knowledge_write";
  if (req.path.includes("/integrations") || req.path.includes("/feedback")) return "knowledge_write";
  if (req.path.includes("/human-gates")) return "knowledge_write";
  if (req.path.includes("/cycles") || req.path.includes("/predictions") || req.path.includes("/projects")) return "knowledge_write";
  return "filesystem_write";
}

function isReadOnlyApiRequest(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  return req.method === "POST" && req.path === "/knowledge/search";
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/healthz", (_req, res) => res.json(buildHealthz()));
  app.get("/readyz", (_req, res) => {
    const ready = buildReadyz();
    res.status(ready.status === "ready" ? 200 : 503).json(ready);
  });
  app.get("/metrics", metricsAccessMiddleware, (req, res) => {
    if (req.query.format === "json") return res.json(buildMetricsSnapshot());
    res.type("text/plain; version=0.0.4").send(renderPrometheusMetrics());
  });

  app.param("id", (req, res, next, value) => {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) return res.status(400).json({ message: "invalid id parameter" });
    req.params.id = parsed.data;
    return next();
  });

  app.param("sourceId", (req, res, next, value) => {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) return res.status(400).json({ message: "invalid id parameter" });
    req.params.sourceId = parsed.data;
    return next();
  });

  app.use("/api", apiAuthMiddleware);

  app.use("/api", (req, res, next) => {
    const mode = runModeFromEnv();
    if (!isLongRunMode(mode) || isReadOnlyApiRequest(req)) return next();
    const capability = mutatingCapabilityForRequest(req);
    const decision = evaluateCapability(capability);
    auditCapabilityDecision({
      actor: "api",
      capability,
      target: `${req.method} ${req.path}`,
      payload: { params: req.params, query: req.query, body: req.body },
    }, decision);
    if (decision.dryRun) {
      return res.status(202).json({
        status: "dry_run",
        mode,
        capability,
        target: `${req.method} ${req.path}`,
        message: `${mode} mode recorded the requested write in action_ledger and did not execute it.`,
      });
    }
    if (!decision.allowed) return res.status(403).json({ message: decision.reason, capability });
    return next();
  });

  // ---------------- seed demo ----------------
  app.post("/api/seed-demo", async (_req, res) => {
    const r = await seedDemo();
    res.json(r);
  });

  // ---------------- projects ----------------
  app.get("/api/projects", (_req, res) => {
    res.json(storage.listProjects().map((p) => parseJsonFields(p, ["redlines"])));
  });
  app.get("/api/projects/:id", (req, res) => {
    const p = storage.getProject(req.params.id);
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["redlines"]));
  });
  app.post("/api/projects", async (req, res) => {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid onboarding", errors: parsed.error.flatten() });
    const project = await createProjectFromOnboarding(parsed.data);
    res.json(parseJsonFields(project, ["redlines"]));
  });
  app.patch("/api/projects/:id", (req, res) => {
    const parsed = projectPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const patch = { ...parsed.data };
    if (patch.redlines) patch.redlines = JSON.stringify(patch.redlines) as any;
    const p = updateProjectConfig(req.params.id, patch as any);
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["redlines"]));
  });

  // ---------------- organization modules ----------------
  app.get("/api/projects/:id/org-modules", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(storage.listOrgModules(project.id).map(parseOrgModule));
  });
  app.post("/api/projects/:id/org-modules", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const parsed = orgModuleInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const module = createOrgModule(project.id, parsed.data);
    res.json(parseOrgModule(module));
  });
  app.get("/api/org-modules/:id", (req, res) => {
    const module = storage.getOrgModule(req.params.id);
    if (!module) return res.status(404).json({ message: "not found" });
    res.json(parseOrgModule(module));
  });
	  app.patch("/api/org-modules/:id", (req, res) => {
	    const parsed = orgModuleInputSchema.partial().safeParse(req.body ?? {});
	    if (!parsed.success) return validationError(res, parsed.error);
	    const module = updateOrgModule(req.params.id, parsed.data);
	    if (!module) return res.status(404).json({ message: "not found" });
	    res.json(parseOrgModule(module));
	  });
  app.delete("/api/org-modules/:id", (req, res) => {
    if (!storage.deleteOrgModule(req.params.id)) return res.status(404).json({ message: "not found" });
    res.json({ deleted: true });
  });
  app.get("/api/org-modules/:id/markdown", (req, res) => {
    const module = storage.getOrgModule(req.params.id);
    if (!module) return res.status(404).json({ message: "not found" });
    res.type("text/markdown").send(orgModuleMarkdown(module));
  });
  app.post("/api/org-modules/:id/knowledge", (req, res) => {
    try {
      const knowledge = convertOrgModuleToKnowledge(req.params.id);
      res.json(parseJsonFields(knowledge, ["tags"]));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("org module not found:")) return res.status(404).json({ message: "not found" });
      throw error;
    }
  });

  // ---------------- external feedback sources ----------------
  app.get("/api/projects/:id/integrations", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(storage.listExternalFeedbackSources(project.id).map((s) => parseJsonFields(s, ["config"])));
  });
  app.post("/api/projects/:id/integrations/github", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const owner = String(req.body?.owner ?? "").trim();
    const repo = String(req.body?.repo ?? "").trim();
    if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required" });
    const source = upsertGithubSource(project.id, owner, repo);
    const syncNow = req.body?.syncNow === true;
    const cycle = storage.listCycles(project.id).find((c) => c.status !== "closed") ?? storage.listCycles(project.id).at(-1);
    const sync = syncNow && cycle
      ? await syncGithubIssuesForSource(source, cycle.id, { token: req.body?.token, limit: req.body?.limit })
      : null;
    res.json({ source: parseJsonFields(source, ["config"]), sync });
  });
  app.post("/api/projects/:id/integrations/github/issues/sync", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const owner = String(req.body?.owner ?? "").trim();
    const repo = String(req.body?.repo ?? "").trim();
    if (!owner || !repo) return res.status(400).json({ message: "owner and repo are required" });
    const source = upsertGithubSource(project.id, owner, repo);
    const cycle = storage.listCycles(project.id).find((c) => c.status !== "closed") ?? storage.listCycles(project.id).at(-1);
    if (!cycle) return res.status(409).json({ message: "project has no cycle to attach feedback" });
    const sync = await syncGithubIssuesForSource(source, cycle.id, { token: req.body?.token, limit: req.body?.limit });
    res.json({ source: parseJsonFields(storage.getExternalFeedbackSource(source.id) ?? source, ["config"]), sync });
  });
  app.post("/api/projects/:id/integrations/:sourceId/sync", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const source = storage.getExternalFeedbackSource(req.params.sourceId);
    if (!source || source.projectId !== project.id) return res.status(404).json({ message: "source not found" });
    const cycle = storage.listCycles(project.id).find((c) => c.status !== "closed") ?? storage.listCycles(project.id).at(-1);
    if (!cycle) return res.status(409).json({ message: "project has no cycle to attach feedback" });
    if (source.kind !== "github_issues") return res.status(400).json({ message: `unsupported source kind ${source.kind}` });
    const sync = await syncGithubIssuesForSource(source, cycle.id, { token: req.body?.token, limit: req.body?.limit });
    res.json({ source: parseJsonFields(storage.getExternalFeedbackSource(source.id) ?? source, ["config"]), sync });
  });
  app.post("/api/projects/:id/feedback/form", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    try {
      const result = await ingestFormFeedback(project.id, {
        sourceName: String(req.body?.sourceName ?? "form"),
        externalId: req.body?.externalId == null ? undefined : String(req.body.externalId),
        title: req.body?.title == null ? undefined : String(req.body.title),
        text: String(req.body?.text ?? ""),
        url: req.body?.url == null ? undefined : String(req.body.url),
      });
      if (result.gate?.status === "pending") {
        void getNotificationBus()
          .then((bus) => {
            if (!bus || !result.gate) return;
            return bus.emit({
              type: "gate_opened",
              projectId: project.id,
              title: `意义闸待处理 — ${project.id}`,
              body: formatGateDecisionRequestText(result.gate, { projectId: project.id }),
              gateId: result.gate.id,
              gateType: result.gate.type as "meaning",
              isBlocking: result.gate.blocking === 1,
              actionUrl: gateWebUrl(notificationBaseUrl(), project.id, result.gate.id),
              meta: { source: "form_feedback" },
            });
          })
          .catch((error) => {
            console.error("[routes] form feedback gate notification failed:", error instanceof Error ? error.message : String(error));
          });
      }
      res.json({
        ...result,
        source: parseJsonFields(result.source, ["config"]),
        gate: result.gate ? parseJsonFields(result.gate, ["payload"]) : null,
      });
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/projects/:id/business-signals", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(storage.listExternalBusinessSignals(project.id).map((signal) => parseJsonFields(signal, ["payload"])));
  });
  app.post("/api/projects/:id/business-signals/import", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const parsed = businessSignalsImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const rows = (parsed.data.rows ?? parsed.data.signals ?? []).map((row) => ({ ...row, projectId: project.id }));
    const result = importBusinessSignals(rows);
    res.json({
      ...result,
      signals: result.signals.map((signal) => parseJsonFields(signal, ["payload"])),
    });
  });

  // ---------------- dashboard summary ----------------
  app.get("/api/projects/:id/dashboard", (req, res) => {
    const projectId = req.params.id;
    const project = storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "not found" });
    const cycles = storage.listCycles(projectId);
    const currentCycle = cycles.find((c) => c.status !== "closed") ?? cycles[cycles.length - 1];
    const knowledge = storage.listKnowledge(projectId);
    const preds = storage.listPredictionsByProject(projectId);
    const gates = storage.listGates(projectId);
    const pendingGates = gates.filter((g) => g.status === "pending");
    const budget = gateBudgetForProject(projectId);
    const llmBudget = llmBudgetForProject(projectId);
    const openPredictions = preds.filter((p) => p.status === "open").length;
    // flywheel stage: last agent run for current cycle
    const runs = currentCycle ? storage.listAgentRuns(currentCycle.id) : [];
    const lastStage = runs.length ? runs[runs.length - 1].agent : "idle";
    const recentKnowledge = [...knowledge].slice(-5).reverse();
    const blockingRisks = pendingGates.filter((g) => g.type === "risk" && g.blocking === 1).length;

    res.json({
      project: parseJsonFields(project, ["redlines"]),
      currentCycle,
      cycleCount: cycles.length,
      flywheelStage: lastStage,
      pendingHuman: pendingGates.length,
      gateBudget: budget,
      llmBudget,
      openPredictions,
      blockingRisks,
      knowledgeCount: knowledge.length,
      strongCount: knowledge.filter((k) => k.status === "strong").length,
      recentKnowledge: recentKnowledge.map((k) => parseJsonFields(k, ["tags"])),
    });
  });
  app.get("/api/flywheel/health", (req, res) => {
    const requestedProjectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const project = requestedProjectId
      ? storage.getProject(requestedProjectId)
      : storage.listProjects()[0];
    if (requestedProjectId && !project) return res.status(404).json({ message: "not found" });
    res.json(buildFlywheelHealth(project?.id));
  });
  app.get("/api/projects/:id/ops-metrics", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(buildOpsMetrics(project.id));
  });
  app.post("/api/projects/:id/provider-canary", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const parsed = providerCanarySchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    res.json(await runProviderCanary({ projectId: project.id, ...parsed.data }));
  });
  app.get("/api/projects/:id/gate-budget", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(gateBudgetForProject(project.id));
  });

  // ---------------- cycles ----------------
  app.post("/api/projects/:id/cycles", (req, res) => {
    const projectId = req.params.id;
    const cycles = storage.listCycles(projectId);
    const idx = cycles.length + 1;
    const sc = scenarioForCycle(idx);
    if (!sc) return res.status(409).json({ message: `cycle ${idx} has no explicit scenario configured` });
    const cyc = storage.createCycle({
      id: `cycle_${idx}_${projectId.slice(-4)}`, projectId, idx,
      goal: sc.proposedGoal, status: "planning", eCycle: null, worstClaimError: null, reasoning: "", version: 1,
    });
    storage.updateProject(projectId, { currentCycleIdx: idx });
    res.json(cyc);
  });
  app.get("/api/projects/:id/cycles", (req, res) => {
    res.json(storage.listCycles(req.params.id));
  });
  app.get("/api/cycles/:id", (req, res) => {
    const c = storage.getCycle(req.params.id);
    if (!c) return res.status(404).json({ message: "not found" });
    res.json(c);
  });
  app.post("/api/cycles/:id/start", (req, res) => {
    const c = storage.updateCycle(req.params.id, { status: "running" });
    if (!c) return res.status(404).json({ message: "not found" });
    res.json(c);
  });
  app.post("/api/cycles/:id/close", (req, res) => {
    const c = storage.updateCycle(req.params.id, { status: "closed" });
    if (!c) return res.status(404).json({ message: "not found" });
    res.json(c);
  });

  // ---------------- run-full ----------------
  app.post("/api/cycles/:id/run-full", costEndpointRateLimit("run-full"), async (req, res) => {
    const cycle = storage.getCycle(String(req.params.id));
    if (!cycle) return res.status(404).json({ message: "not found" });
    const r = await runFullCycle(cycle.projectId, cycle.id);
    res.json(r);
  });

  // ---------------- scheduler ----------------
  app.post("/api/projects/:id/scheduler/tick", costEndpointRateLimit("scheduler-tick"), async (req, res) => {
    const parsed = feedbackSyncSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    req.body = parsed.data;
    const project = storage.getProject(String(req.params.id));
    if (!project) return res.status(404).json({ message: "not found" });
    const syncOptions = feedbackSyncOptions(req);
    if (req.body?.syncFeedback !== false) await syncConfiguredFeedbackForProject(project.id, undefined, syncOptions);
    res.json(await schedulerTickProject(project.id, { feedbackSync: syncOptions }));
  });
  app.post("/api/scheduler/tick", costEndpointRateLimit("scheduler-tick"), async (req, res) => {
    const parsed = feedbackSyncSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    req.body = parsed.data;
    const projectId = req.body?.projectId ?? req.query.projectId;
    const syncOptions = feedbackSyncOptions(req);
    if (projectId) {
      const project = storage.getProject(String(projectId));
      if (!project) return res.status(404).json({ message: "not found" });
      if (req.body?.syncFeedback !== false) await syncConfiguredFeedbackForProject(project.id, undefined, syncOptions);
      return res.json(await schedulerTickProject(project.id, { feedbackSync: syncOptions }));
    }
    if (req.body?.syncFeedback !== false) {
      for (const project of storage.listProjects()) await syncConfiguredFeedbackForProject(project.id, undefined, syncOptions);
    }
    res.json(await schedulerTickAllProjects({ feedbackSync: syncOptions }));
  });

  // ---------------- cycle review ----------------
  app.get("/api/cycles/:id/review", (req, res) => {
    const cycle = storage.getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: "not found" });
    const feedback = storage.listFeedback(cycle.id);
    const preds = storage.listPredictions(cycle.id).map((p) => parseJsonFields(p, ["claims", "knowledgeRefs"]));
    const tasks = storage.listTasks(cycle.id);
    const runs = storage.listAgentRuns(cycle.id).map((r) => parseJsonFields(r, ["knowledgeRefsUsed"]));
    const decisions = storage.listDecisions(cycle.projectId).filter((d) => d.cycleId === cycle.id);
    const actionLedger = storage.listActionLedger(cycle.projectId)
      .filter((item) => item.cycleId === cycle.id)
      .map((item) => parseJsonFields(item, ["payload", "rollbackPlan", "auditSummary"]));
    // knowledge referenced by predictions this cycle (compounding evidence)
    const refIds = new Set<string>();
    for (const p of preds) for (const r of (p.knowledgeRefs as unknown as string[])) refIds.add(r);
    const referencedKnowledge = Array.from(refIds).map((id) => storage.getKnowledge(id)).filter(Boolean).map((k) => parseJsonFields(k as any, ["tags"]));
    const knowledgeUpdated = storage.listKnowledge(cycle.projectId).filter((k) => k.lastValidatedCycle === cycle.idx || k.createdByCycle === cycle.idx).map((k) => parseJsonFields(k, ["tags"]));
    const bugs = feedback.filter((f) => f.category === "bug");
    res.json({ cycle, feedback, predictions: preds, tasks, agentRuns: runs, decisions, actionLedger, referencedKnowledge, knowledgeUpdated, bugs });
  });
  app.get("/api/cycles/:id/traces", (req, res) => {
    const cycle = storage.getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: "not found" });
    res.json(storage.listTraceEventsByCycle(cycle.id, numericLimit(req.query.limit)).map(parseTraceEvent));
  });
  app.get("/api/projects/:id/traces", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    res.json(storage.listTraceEventsByProject(project.id, numericLimit(req.query.limit)).map(parseTraceEvent));
  });
  app.get("/api/action-ledger", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json(storage.listActionLedger(projectId).slice(-numericLimit(req.query.limit, 200)).reverse());
  });

  // ---------------- human gates ----------------
  const humanGateService = new HumanGateService(storage);
  app.get("/api/human-gates", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const gates = storage
      .listGates(projectId)
      .filter((gate) => !status || gate.status === status)
      .filter((gate) => !type || gate.type === type)
      .map((g) => parseJsonFields(g, ["payload"]));
    if (req.query.summary === "true") {
      return res.json({
        items: gates,
        total: gates.length,
        pendingCount: gates.filter((gate) => gate.status === "pending").length,
      });
    }
    res.json(gates);
  });
  app.get("/api/human-gates/:id", (req, res) => {
    const g = storage.getGate(req.params.id);
    if (!g) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(g, ["payload"]));
  });

  function emitGateResolutionReceipt(gate: NonNullable<ReturnType<typeof storage.getGate>>, action: GateDecisionAction, context: {
    dryRun: boolean;
    rationale?: string;
    via: string;
  }) {
    if (action === "modify") return;
    const projectId = storage.getCycle(gate.cycleId)?.projectId ?? "system";
    void getNotificationBus()
      .then((bus) => {
        if (!bus) return;
        const pendingGatesAfter = storage.listGates(projectId).filter((item) => item.status === "pending").length;
        const openConflictReviewsAfter = storage
          .listKnowledgeReviews(projectId)
          .filter((review) => review.reviewType === "conflict" && review.status === "review_required")
          .length;
        const label = action === "approve" ? "已批准" : "已否决";
        return bus.emit({
          type: "gate_resolved",
          projectId,
          title: `${label} — ${gate.title}`,
          body: formatGateDecisionReceiptText(gate, {
            action,
            dryRun: context.dryRun,
            via: context.via,
            decidedAt: new Date(),
            pendingGatesAfter,
            openConflictReviewsAfter,
            knowledgeId: action === "approve" && gate.type === "meaning" ? knowledgeIdForMeaningGate(gate.id) : null,
            projectId,
            rationale: context.rationale,
          }),
          gateId: gate.id,
          gateType: gate.type as "direction" | "meaning" | "risk",
          isBlocking: gate.blocking === 1,
          actionUrl: gateWebUrl(notificationBaseUrl(), projectId, gate.id),
          meta: { source: "api_human_gate_resolution" },
        });
      })
      .catch((error) => {
        console.error("[routes] gate resolution receipt failed:", error instanceof Error ? error.message : String(error));
      });
  }

  function resolveGate(req: Request, res: Response, action: GateDecisionAction) {
    const parsed = gateDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    if (action === "reject" && !parsed.data.reasonCode) {
      return res.status(400).json({ message: "reasonCode is required for reject" });
    }
    try {
      const gateBefore = storage.getGate(String(req.params.id));
      const wasPending = gateBefore?.status === "pending";
      const result = humanGateService.resolve(String(req.params.id), action, {
        rationale: parsed.data.rationale,
        via: "web",
        actor: "human",
        reasonCode: parsed.data.reasonCode === "risk_too_high" ? "too_risky" : parsed.data.reasonCode,
        reviewOpenedAt: parsed.data.reviewOpenedAt,
      });
      if (wasPending) {
        emitGateResolutionReceipt(result.gate, action, {
          dryRun: result.dryRun,
          rationale: parsed.data.rationale,
          via: "Web/API",
        });
      }
      if (result.dryRun) {
        return res.status(202).json({
          status: "dry_run",
          message: "Gate decision was recorded but not applied in the current run mode.",
          gate: parseJsonFields(result.gate as any, ["payload"]),
        });
      }
      return res.json(parseJsonFields(result.gate as any, ["payload"]));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("human gate not found:")) {
        return res.status(404).json({ message: "not found" });
      }
      if (error instanceof Error && error.message.includes("requires reason_code")) {
        return res.status(400).json({ message: error.message });
      }
      throw error;
    }
  }
  app.post("/api/human-gates/:id/approve", (req, res) => resolveGate(req, res, "approve"));
  app.post("/api/human-gates/:id/reject", (req, res) => resolveGate(req, res, "reject"));
  app.post("/api/human-gates/:id/modify", (req, res) => resolveGate(req, res, "modify"));
  app.post("/api/human-gates/:id/defer", (req, res) => {
    const parsed = gateDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      const result = humanGateService.defer(String(req.params.id), parsed.data.deferUntil ?? null, {
        rationale: parsed.data.rationale,
        via: "web",
        actor: "human",
        reviewOpenedAt: parsed.data.reviewOpenedAt,
      });
      return res.json(parseJsonFields(result.gate as any, ["payload"]));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("human gate not found:")) {
        return res.status(404).json({ message: "not found" });
      }
      return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/human-gates/:id/revoke", (req, res) => {
    const parsed = gateDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      const result = humanGateService.revoke(String(req.params.id), {
        rationale: parsed.data.rationale,
        via: "web",
        actor: "human",
      });
      return res.json(parseJsonFields(result.gate as any, ["payload"]));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("human gate not found:")) {
        return res.status(404).json({ message: "not found" });
      }
      return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  // ---------------- predictions ----------------
  app.get("/api/cycles/:id/predictions", (req, res) => {
    res.json(storage.listPredictions(req.params.id).map((p) => parseJsonFields(p, ["claims", "knowledgeRefs"])));
  });
  app.get("/api/projects/:id/predictions", (req, res) => {
    res.json(storage.listPredictionsByProject(req.params.id).map((p) => parseJsonFields(p, ["claims", "knowledgeRefs"])));
  });
  app.post("/api/predictions", (req, res) => {
    const parsed = predictionCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const body = parsed.data;
    const pred = storage.createPrediction({
      id: body.id ?? `pred_${Date.now().toString(36)}`, cycleId: body.cycleId,
      belief: body.belief ?? "", prediction: body.prediction ?? "", action: body.action ?? "",
      claims: JSON.stringify(body.claims ?? []), observation: body.observation ?? null,
      predictionError: body.predictionError ?? null, worstClaimError: body.worstClaimError ?? null,
      errorType: body.errorType ?? null, updateTarget: body.updateTarget ?? null,
      status: body.status ?? "open", knowledgeRefs: JSON.stringify(body.knowledgeRefs ?? []),
    });
    res.json(parseJsonFields(pred, ["claims", "knowledgeRefs"]));
  });
  app.patch("/api/predictions/:id/observation", (req, res) => {
    const parsed = predictionObservationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const p = storage.updatePrediction(req.params.id, { observation: parsed.data.observation });
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["claims", "knowledgeRefs"]));
  });
  app.patch("/api/predictions/:id/error", (req, res) => {
    const parsed = predictionErrorSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const p = storage.updatePrediction(req.params.id, {
      predictionError: parsed.data.predictionError,
      worstClaimError: parsed.data.worstClaimError,
      errorType: parsed.data.errorType,
      updateTarget: parsed.data.updateTarget,
      status: "resolved",
    });
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["claims", "knowledgeRefs"]));
  });

  // ---------------- knowledge ----------------
  app.get("/api/knowledge", (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.json([]);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const knowledge = storage
      .listKnowledge(projectId)
      .filter((item) => !status || item.status === status)
      .map((k) => parseJsonFields(k, ["tags"]));
    if (req.query.summary === "true") {
      return res.json({ items: knowledge, total: knowledge.length });
    }
    res.json(knowledge);
  });
  app.get("/api/knowledge/:id", (req, res) => {
    const k = storage.getKnowledge(req.params.id);
    if (!k) return res.status(404).json({ message: "not found" });
    const referenceLimit = 50;
    const runs = storage.listAgentRunsReferencingKnowledge(k.id, k.projectId, referenceLimit + 1);
    const visibleRuns = runs.slice(0, referenceLimit);
    res.json({
      ...parseJsonFields(k, ["tags"]),
      referencedByAgents: visibleRuns.map((r) => ({ agent: r.agent, cycleIdx: r.cycleIdx, action: r.action })),
      referencedByAgentsLimit: referenceLimit,
      referencedByAgentsTruncated: runs.length > referenceLimit,
    });
  });
  app.post("/api/knowledge", (req, res) => {
    const parsed = knowledgeCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const b = parsed.data;
    const k = storage.createKnowledge({
      id: b.id ?? `kb_${Date.now().toString(36)}`, projectId: b.projectId, type: b.type ?? "fact",
      title: b.title, content: b.content, sourceType: b.sourceType ?? "agent_observation", sourceRef: b.sourceRef ?? "",
      evidenceAlpha: 1, evidenceBeta: 1, confidenceScore: 0.5, confidenceLevel: "low", status: "draft",
      humanApprovedCount: 0, externalVerifiedCount: 0, validFrom: now().slice(0, 10), validUntil: null,
      lastValidatedCycle: b.cycleIdx ?? 0, createdByCycle: b.cycleIdx ?? 0, createdBy: b.createdBy ?? "distiller",
      approvedBy: null, usageCount: 0, tags: JSON.stringify(b.tags ?? []), notes: b.notes ?? "", version: 1,
    });
    res.json(parseJsonFields(k, ["tags"]));
  });
  app.patch("/api/knowledge/:id", (req, res) => {
    const parsed = knowledgePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const { tags, ...rest } = parsed.data;
    const patch: Partial<KnowledgeItem> = { ...rest };
    if (tags && Array.isArray(tags)) patch.tags = JSON.stringify(tags);
    const k = storage.updateKnowledge(req.params.id, { ...patch, actor: "human" });
    if (!k) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(k, ["tags"]));
  });
  app.post("/api/knowledge/:id/approve", (req, res) => {
    const k = storage.getKnowledge(req.params.id);
    if (!k) return res.status(404).json({ message: "not found" });
    const core = { ...k, tags: JSON.parse(k.tags) } as any;
    const r = applyEvidence(core, { kind: "human_approve" });
    // attempt strong promotion (human approved)
    const t = transitionState({ ...core, ...r.next, humanApprovedCount: r.next.humanApprovedCount } as any, {
      currentCycle: k.lastValidatedCycle, conflictsWithStrong: false, humanApprovedStrongPromotion: true,
    });
    const updated = storage.updateKnowledge(k.id, {
      evidenceAlpha: r.next.evidenceAlpha, evidenceBeta: r.next.evidenceBeta,
      confidenceScore: r.next.confidenceScore, confidenceLevel: r.next.confidenceLevel,
      humanApprovedCount: r.next.humanApprovedCount, approvedBy: "owner",
      actor: "human",
      status: t.changed ? t.nextStatus : (k.status === "draft" ? "active" : k.status),
    });
    storage.recordEvent({ cycleIdx: k.lastValidatedCycle, actor: "human", tableName: "knowledge_items", op: "approve", before: JSON.stringify({ status: k.status }), after: JSON.stringify({ status: updated?.status }), ts: now() });
    res.json(parseJsonFields(updated as any, ["tags"]));
  });
  app.post("/api/knowledge/:id/quarantine", (req, res) => {
    const k = storage.updateKnowledge(req.params.id, { status: "quarantined", actor: "human" });
    if (!k) return res.status(404).json({ message: "not found" });
    storage.recordEvent({ cycleIdx: k.lastValidatedCycle, actor: "human", tableName: "knowledge_items", op: "quarantine", before: null, after: JSON.stringify({ id: k.id }), ts: now() });
    res.json(parseJsonFields(k, ["tags"]));
  });
  app.get("/api/projects/:id/knowledge-reviews", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    const status = rawStatus === "pending" || rawStatus === "open" ? "review_required" : rawStatus;
    const reviewType = typeof req.query.reviewType === "string" ? req.query.reviewType : undefined;
    const reviews = storage
      .listKnowledgeReviews(project.id)
      .filter((review) => !status || status === "all" || review.status === status)
      .filter((review) => !reviewType || review.reviewType === reviewType)
      .map((review) => parseJsonFields(review, ["evidence", "resolution"]));
    if (req.query.summary === "true") {
      return res.json({
        items: reviews,
        total: reviews.length,
        reviewRequiredCount: reviews.filter((review) => review.status === "review_required").length,
      });
    }
    res.json(reviews);
  });
  app.post("/api/projects/:id/knowledge/conflicts/scan", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const conflicts = detectKnowledgeConflicts(project.id);
    res.json({
      conflicts,
      reviews: storage.listKnowledgeReviews(project.id).filter((review) => review.status === "review_required").map((review) => parseJsonFields(review, ["evidence", "resolution"])),
    });
  });
  app.post("/api/projects/:id/knowledge/review-reminders", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const reminders = createKnowledgeReviewReminders(project.id, {
      staleAfterDays: typeof req.body?.staleAfterDays === "number" ? req.body.staleAfterDays : undefined,
      expiryWithinDays: typeof req.body?.expiryWithinDays === "number" ? req.body.expiryWithinDays : undefined,
    });
    res.json(reminders.map((review) => parseJsonFields(review, ["evidence", "resolution"])));
  });
  app.post("/api/knowledge-reviews/:id/resolve", (req, res) => {
    const parsed = knowledgeReviewResolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    try {
      const reviewGateBefore = storage.getGate(`gate_${req.params.id}`);
      const wasPending = reviewGateBefore?.status === "pending";
      const review = resolveKnowledgeReview(req.params.id, { ...parsed.data, actor: "human" });
      const reviewGateAfter = storage.getGate(`gate_${req.params.id}`);
      if (wasPending && reviewGateAfter) {
        emitGateResolutionReceipt(reviewGateAfter, "approve", {
          dryRun: false,
          rationale: `知识冲突复核已处理：${parsed.data.action}。${parsed.data.rationale}`.trim(),
          via: "Web/API",
        });
      }
      res.json(parseJsonFields(review, ["evidence", "resolution"]));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("knowledge review not found:")) return res.status(404).json({ message: "not found" });
      if (error instanceof Error && error.message.startsWith("knowledge review already resolved:")) return res.status(409).json({ message: "already resolved" });
      throw error;
    }
  });
  app.post("/api/knowledge/search", (req, res) => {
    const projectId = String(req.body?.projectId ?? "");
    const query = String(req.body?.query ?? "");
    if (!projectId || !query) return res.json([]);
    res.json(storage.searchKnowledge(projectId, query).map((k) => parseJsonFields(k, ["tags"])));
  });

  // ---------------- agents ----------------
  app.get("/api/projects/:id/agents", (req, res) => {
    res.json(storage.listAgents(req.params.id));
  });
  app.get("/api/projects/:id/agent-runs", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const cycleIds = new Set(storage.listCycles(project.id).map((cycle) => cycle.id));
    const runs = storage
      .listAgentRuns()
      .filter((run) => cycleIds.has(run.cycleId))
      .map((run) => parseJsonFields(run, ["knowledgeRefsUsed"]));
    res.json(runs);
  });
  app.get("/api/cycles/:id/agent-runs", (req, res) => {
    res.json(storage.listAgentRuns(req.params.id).map((r) => parseJsonFields(r, ["knowledgeRefsUsed"])));
  });
  app.post("/api/projects/:id/builder/codex/plan", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const parsed = builderPlanSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error);
    const adapter = new CodexCliBuilderAdapter();
    res.json(await adapter.generateChangePackage({ projectId: project.id, ...parsed.data }));
  });
  app.post("/api/builder/codex/apply", async (req, res) => {
    const adapter = new CodexCliBuilderAdapter();
    try {
      res.json(await adapter.applyChangePackage(req.body?.package ?? req.body, {
        dryRun: req.body?.dryRun !== false,
        actor: "human",
      }));
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  });
  // individual agent run endpoints (PRD 15) — no-op stubs that re-run a stage are out of scope for MVP;
  // run-full is the supported demo path. Provide them for API completeness.
  for (const agent of ["orchestrator", "sensor", "builder", "distiller", "librarian"]) {
    app.post(`/api/agents/${agent}/run`, (req, res) => {
      res.json({ agent, note: "MVP: use POST /api/cycles/:id/run-full for full sequential scheduling" });
    });
  }

  // ---------------- diagnostics ----------------
  app.get("/api/llm-calls", (_req, res) => res.json(storage.listLlmCalls()));
  app.get("/api/projects/:id/llm-calls", (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const cycleIds = new Set(storage.listCycles(project.id).map((cycle) => cycle.id));
    res.json(storage.listLlmCalls().filter((call) => cycleIds.has(call.cycleId)));
  });
  app.get("/api/llm-calls/latency", (_req, res) => {
    const snapshot = buildMetricsSnapshot();
    res.json(snapshot.perAgentLatency);
  });
  app.get("/api/llm-calls/summary", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const calls = storage.listLlmCalls().filter((call) => {
      if (!projectId) return true;
      return storage.getCycle(call.cycleId)?.projectId === projectId;
    });
    const sumBy = (keyFor: (call: typeof calls[number]) => string, valueFor: (call: typeof calls[number]) => number) => {
      const out: Record<string, number> = {};
      for (const call of calls) out[keyFor(call)] = +(Number(out[keyFor(call)] ?? 0) + valueFor(call)).toFixed(6);
      return out;
    };
    res.json({
      count: calls.length,
      totalTokens: calls.reduce((s, c) => s + c.tokenCount, 0),
      inputTokens: calls.reduce((s, c) => s + c.inputTokenCount, 0),
      outputTokens: calls.reduce((s, c) => s + c.outputTokenCount, 0),
      totalCost: +calls.reduce((s, c) => s + c.estimatedCost, 0).toFixed(6),
      byAgent: Object.fromEntries(["orchestrator", "sensor", "builder", "distiller", "librarian"].map((a) => [a, calls.filter((c) => c.agent === a).length])),
      byModel: sumBy((c) => c.model, () => 1),
      byRoute: sumBy((c) => c.routeReason, () => 1),
      costByModel: sumBy((c) => c.model, (c) => c.estimatedCost),
    });
  });
  app.get("/api/event-log", (_req, res) => res.json(storage.listEvents()));
  app.get("/api/decision-log", (req, res) => res.json(storage.listDecisions(req.query.projectId as string | undefined)));

  return httpServer;
}
