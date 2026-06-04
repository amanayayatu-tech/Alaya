import type { Express, Request, Response } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage, now } from "./storage";
import { onboardingSchema } from "@shared/schema";
import { createProjectFromOnboarding } from "./onboarding";
import { updateProjectConfig } from "./projectConfig";
import { runFullCycle, scenarioForCycle } from "./flywheel";
import { gateBudgetForProject, llmBudgetForProject, schedulerTickAllProjects, schedulerTickProject } from "./scheduler";
import { ingestFormFeedback, syncConfiguredFeedbackForProject, syncGithubIssuesForSource, upsertGithubSource } from "./externalFeedback";
import { seedDemo } from "./seed";
import { applyEvidence } from "@shared/core/update_confidence.js";
import { transitionState } from "@shared/core/transition_state.js";

function parseJsonFields<T extends Record<string, any>>(obj: T, fields: string[]): T {
  const out: any = { ...obj };
  for (const f of fields) {
    if (typeof out[f] === "string") {
      try { out[f] = JSON.parse(out[f]); } catch { /* keep */ }
    }
  }
  return out;
}

function feedbackSyncOptions(req: Request) {
  return {
    token: req.body?.token ?? req.body?.githubToken,
    limit: req.body?.limit,
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
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
    const p = updateProjectConfig(req.params.id, req.body);
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["redlines"]));
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
      res.json({
        ...result,
        source: parseJsonFields(result.source, ["config"]),
        gate: result.gate ? parseJsonFields(result.gate, ["payload"]) : null,
      });
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    }
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
  app.post("/api/cycles/:id/run-full", async (req, res) => {
    const cycle = storage.getCycle(req.params.id);
    if (!cycle) return res.status(404).json({ message: "not found" });
    const r = await runFullCycle(cycle.projectId, cycle.id);
    res.json(r);
  });

  // ---------------- scheduler ----------------
  app.post("/api/projects/:id/scheduler/tick", async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ message: "not found" });
    const syncOptions = feedbackSyncOptions(req);
    if (req.body?.syncFeedback !== false) await syncConfiguredFeedbackForProject(project.id, undefined, syncOptions);
    res.json(await schedulerTickProject(project.id, { feedbackSync: syncOptions }));
  });
  app.post("/api/scheduler/tick", async (req, res) => {
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
    // knowledge referenced by predictions this cycle (compounding evidence)
    const refIds = new Set<string>();
    for (const p of preds) for (const r of (p.knowledgeRefs as unknown as string[])) refIds.add(r);
    const referencedKnowledge = Array.from(refIds).map((id) => storage.getKnowledge(id)).filter(Boolean).map((k) => parseJsonFields(k as any, ["tags"]));
    const knowledgeUpdated = storage.listKnowledge(cycle.projectId).filter((k) => k.lastValidatedCycle === cycle.idx || k.createdByCycle === cycle.idx).map((k) => parseJsonFields(k, ["tags"]));
    const bugs = feedback.filter((f) => f.category === "bug");
    res.json({ cycle, feedback, predictions: preds, tasks, agentRuns: runs, decisions, referencedKnowledge, knowledgeUpdated, bugs });
  });

  // ---------------- human gates ----------------
  app.get("/api/human-gates", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    res.json(storage.listGates(projectId).map((g) => parseJsonFields(g, ["payload"])));
  });
  app.get("/api/human-gates/:id", (req, res) => {
    const g = storage.getGate(req.params.id);
    if (!g) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(g, ["payload"]));
  });
  function resolveGate(req: Request, res: Response, status: string, decision: string) {
    const gate = storage.getGate(String(req.params.id));
    if (!gate) return res.status(404).json({ message: "not found" });
    const dec = (req.body?.decision as string) || decision;
    const rationale = (req.body?.rationale as string) || "";
    const updated = storage.updateGate(gate.id, { status, decision: dec });
    storage.createDecision({
      id: `dec_${gate.id}_${Date.now().toString(36)}`, cycleId: gate.cycleId,
      gateType: gate.type, decision: dec, rationale, ts: now(),
    });
    storage.recordEvent({ cycleIdx: 0, actor: "human", tableName: "human_gate_items", op: "resolve", before: JSON.stringify({ status: gate.status }), after: JSON.stringify({ status }), ts: now() });
    res.json(parseJsonFields(updated as any, ["payload"]));
  }
  app.post("/api/human-gates/:id/approve", (req, res) => resolveGate(req, res, "approved", "approve"));
  app.post("/api/human-gates/:id/reject", (req, res) => resolveGate(req, res, "rejected", "reject"));
  app.post("/api/human-gates/:id/modify", (req, res) => resolveGate(req, res, "modified", "modify"));

  // ---------------- predictions ----------------
  app.get("/api/cycles/:id/predictions", (req, res) => {
    res.json(storage.listPredictions(req.params.id).map((p) => parseJsonFields(p, ["claims", "knowledgeRefs"])));
  });
  app.get("/api/projects/:id/predictions", (req, res) => {
    res.json(storage.listPredictionsByProject(req.params.id).map((p) => parseJsonFields(p, ["claims", "knowledgeRefs"])));
  });
  app.post("/api/predictions", (req, res) => {
    const body = req.body;
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
    const p = storage.updatePrediction(req.params.id, { observation: req.body.observation });
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["claims", "knowledgeRefs"]));
  });
  app.patch("/api/predictions/:id/error", (req, res) => {
    const p = storage.updatePrediction(req.params.id, {
      predictionError: req.body.predictionError, worstClaimError: req.body.worstClaimError,
      errorType: req.body.errorType, updateTarget: req.body.updateTarget, status: "resolved",
    });
    if (!p) return res.status(404).json({ message: "not found" });
    res.json(parseJsonFields(p, ["claims", "knowledgeRefs"]));
  });

  // ---------------- knowledge ----------------
  app.get("/api/knowledge", (req, res) => {
    const projectId = req.query.projectId as string;
    if (!projectId) return res.json([]);
    res.json(storage.listKnowledge(projectId).map((k) => parseJsonFields(k, ["tags"])));
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
    const b = req.body;
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
    const patch = { ...req.body };
    if (patch.tags && Array.isArray(patch.tags)) patch.tags = JSON.stringify(patch.tags);
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
  app.get("/api/cycles/:id/agent-runs", (req, res) => {
    res.json(storage.listAgentRuns(req.params.id).map((r) => parseJsonFields(r, ["knowledgeRefsUsed"])));
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
  app.get("/api/llm-calls/summary", (_req, res) => {
    const calls = storage.listLlmCalls();
    res.json({
      count: calls.length,
      totalTokens: calls.reduce((s, c) => s + c.tokenCount, 0),
      totalCost: +calls.reduce((s, c) => s + c.estimatedCost, 0).toFixed(6),
      byAgent: Object.fromEntries(["orchestrator", "sensor", "builder", "distiller", "librarian"].map((a) => [a, calls.filter((c) => c.agent === a).length])),
    });
  });
  app.get("/api/event-log", (_req, res) => res.json(storage.listEvents()));
  app.get("/api/decision-log", (req, res) => res.json(storage.listDecisions(req.query.projectId as string | undefined)));

  return httpServer;
}
