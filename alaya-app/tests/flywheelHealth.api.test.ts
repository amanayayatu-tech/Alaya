import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-health-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { rawDb, storage } = await import("../server/storage.ts");
const { registerRoutes } = await import("../server/routes.ts");
const { runFullCycle, scenarioForCycle } = await import("../server/flywheel.ts");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function createProject(projectId: string) {
  storage.createProject({
    id: projectId,
    name: `Health ${projectId}`,
    direction: "Validate flywheel health",
    targetUser: "operator teams",
    redlines: JSON.stringify(["no irreversible action without audit"]),
    weeklyHumanMinutes: 240,
    weeklyLlmBudgetCents: 10_000,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "Health project validates compounding proof.",
    worldModel: "Preview, rollback and audit constraints increase trust.",
    currentCycleIdx: 1,
    version: 1,
  });
}

function createCycle(projectId: string, idx: number) {
  const scenario = scenarioForCycle(idx);
  return storage.createCycle({
    id: `cycle_${idx}_${projectId.slice(-8)}`,
    projectId,
    idx,
    goal: scenario?.proposedGoal ?? `cycle ${idx}`,
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

type KnowledgeStatus = "draft" | "active" | "strong" | "stale" | "expired" | "quarantined" | "conflict" | "deprecated" | "rejected";

function createKnowledge(projectId: string, id: string, createdByCycle: number, status: KnowledgeStatus = "active") {
  return storage.createKnowledge({
    id,
    projectId,
    type: "principle",
    title: `Knowledge ${id}`,
    content: `Dynamic compounding evidence ${id}`,
    sourceType: "test",
    sourceRef: id,
    evidenceAlpha: 2,
    evidenceBeta: 1,
    confidenceScore: 2 / 3,
    confidenceLevel: "medium",
    status,
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: createdByCycle,
    createdByCycle,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["test"]),
    notes: "",
    semanticKey: id,
    supersededBy: null,
    version: 1,
  });
}

const projectId = "proj_health_four_rounds";

test.before(async () => {
  createProject(projectId);
  for (let idx = 1; idx <= 4; idx += 1) {
    const cycle = createCycle(projectId, idx);
    await runFullCycle(projectId, cycle.id);
  }
});

async function getHealth(targetProjectId = projectId) {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/flywheel/health?projectId=${targetProjectId}`);
  const body = await response.json() as any;
  return { response, body };
}

test("flywheel health returns 200 and the expected structure", async () => {
  const { response, body } = await getHealth();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.rounds));
  assert.ok(body.totals);
  assert.ok(body.compoundingProof);
  assert.equal(typeof body.compoundingProof.round1vs4KnowledgeDelta, "number");
});

test("flywheel health rounds length matches database cycles", async () => {
  const { body } = await getHealth();
  assert.equal(body.rounds.length, storage.listCycles(projectId).length);
});

test("flywheel health strong total matches knowledge_items", async () => {
  const { body } = await getHealth();
  const row = rawDb.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_items
    WHERE project_id = ? AND status = 'strong'
  `).get(projectId) as { count: number };
  assert.equal(body.totals.strongKnowledgeCount, row.count);
});

test("flywheel health proves four-round knowledge compounding", async () => {
  const { body } = await getHealth();
  assert.ok(body.compoundingProof.round1vs4KnowledgeDelta > 0);
});

test("flywheel health delta keeps moving after round 4", async () => {
  const dynamicProjectId = "proj_health_dynamic_delta";
  createProject(dynamicProjectId);
  createCycle(dynamicProjectId, 1);
  createCycle(dynamicProjectId, 5);
  createKnowledge(dynamicProjectId, "kb_dynamic_r1", 1);
  createKnowledge(dynamicProjectId, "kb_dynamic_r5", 5);

  const { body } = await getHealth(dynamicProjectId);
  assert.equal(body.compoundingProof.round1vs4StaticKnowledgeDelta, 0);
  assert.equal(body.compoundingProof.round1vsCurrentKnowledgeDelta, 1);
  assert.equal(body.compoundingProof.round1vs4KnowledgeDelta, 1);
});

test("knowledge and human gate list endpoints support status filters and summaries", async () => {
  const filterProjectId = "proj_api_filter_contract";
  createProject(filterProjectId);
  const cycle = createCycle(filterProjectId, 1);
  createKnowledge(filterProjectId, "kb_filter_active", 1, "active");
  createKnowledge(filterProjectId, "kb_filter_conflict", 1, "conflict");
  storage.createGate({
    id: "gate_filter_pending",
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "pending gate",
    payload: "{}",
    status: "pending",
    estimatedMinutes: 3,
    decision: null,
    version: 1,
  });
  storage.createGate({
    id: "gate_filter_approved",
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "approved gate",
    payload: "{}",
    status: "approved",
    estimatedMinutes: 3,
    decision: "approve",
    version: 1,
  });

  const address = server.address() as AddressInfo;
  const activeKnowledge = await fetch(`http://127.0.0.1:${address.port}/api/knowledge?projectId=${filterProjectId}&status=active`).then((res) => res.json()) as any[];
  const knowledgeSummary = await fetch(`http://127.0.0.1:${address.port}/api/knowledge?projectId=${filterProjectId}&status=conflict&summary=true`).then((res) => res.json()) as any;
  const gateSummary = await fetch(`http://127.0.0.1:${address.port}/api/human-gates?projectId=${filterProjectId}&status=pending&summary=true`).then((res) => res.json()) as any;

  assert.deepEqual(activeKnowledge.map((item) => item.id), ["kb_filter_active"]);
  assert.equal(knowledgeSummary.total, 1);
  assert.deepEqual(knowledgeSummary.items.map((item: any) => item.id), ["kb_filter_conflict"]);
  assert.equal(gateSummary.total, 1);
  assert.equal(gateSummary.pendingCount, 1);
  assert.deepEqual(gateSummary.items.map((item: any) => item.id), ["gate_filter_pending"]);
});
