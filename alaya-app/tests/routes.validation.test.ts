import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-route-validation-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, now } = await import("../server/storage.ts");
const { registerRoutes } = await import("../server/routes.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const { detectKnowledgeConflicts, resolveKnowledgeReview } = await import("../server/knowledgeReview.ts");

storage.createProject({
  id: "proj_validation",
  name: "Validation",
  direction: "Validate routes",
  targetUser: "operator",
  redlines: "[]",
  weeklyHumanMinutes: 150,
  weeklyLlmBudgetCents: 100,
  firstClaimMetric: "activation_rate",
  firstClaimOperator: ">=",
  firstClaimTarget: 0.3,
  seedIdentity: "",
  worldModel: "",
  currentCycleIdx: 1,
  version: 1,
});
storage.createCycle({
  id: "cycle_validation",
  projectId: "proj_validation",
  idx: 1,
  goal: "validate",
  status: "planning",
  eCycle: null,
  worstClaimError: null,
  reasoning: "",
  version: 1,
});
storage.createGate({
  id: "gate_validation",
  cycleId: "cycle_validation",
  type: "risk",
  blocking: 1,
  title: "Validate gate",
  payload: "{}",
  status: "pending",
  estimatedMinutes: 10,
  decision: null,
  version: 1,
});

const app = express();
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

function url(path: string) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
}

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("prediction create requires schema-valid body", async () => {
  const missing = await fetch(url("/api/predictions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 400);

  const valid = await fetch(url("/api/predictions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cycleId: "cycle_validation",
      belief: "Users need a concise status page.",
      prediction: "Activation will improve.",
      action: "Ship the page.",
      claims: [{
        id: "claim_activation_valid",
        type: "metric_threshold",
        metric: "activation_rate",
        operator: ">=",
        target: 0.3,
        observed: 0.4,
        scale: 0.3,
        weight: 3,
      }],
    }),
  });
  assert.equal(valid.status, 200);
  const body = await valid.json() as any;
  assert.equal(body.cycleId, "cycle_validation");
});

test("prediction claim schema requires operator, positive scale and metric weight >= 3", async () => {
  const baseClaim = {
    id: "claim_schema_guard",
    type: "metric_threshold",
    metric: "activation_rate",
    operator: ">=",
    target: 0.3,
    observed: 0.4,
    scale: 0.3,
    weight: 3,
  };
  const post = (claim: Record<string, unknown>) => fetch(url("/api/predictions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cycleId: "cycle_validation",
      belief: "b",
      prediction: "p",
      action: "a",
      claims: [claim],
    }),
  });

  assert.equal((await post({ ...baseClaim, operator: undefined })).status, 400);
  assert.equal((await post({ ...baseClaim, operator: "==" })).status, 400);
  assert.equal((await post({ ...baseClaim, scale: 0 })).status, 400);
  assert.equal((await post({ ...baseClaim, weight: 1 })).status, 400);

  const smallerIsBetter = await post({
    ...baseClaim,
    id: "claim_latency_valid",
    metric: "p95_latency_ms",
    operator: "<=",
    target: 200,
    observed: 180,
    scale: 200,
  });
  assert.equal(smallerIsBetter.status, 200);
});

test("prediction claim schema accepts prediction contracts on non-metric measurable claims", async () => {
  const post = (claim: Record<string, unknown>) => fetch(url("/api/predictions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cycleId: "cycle_validation",
      belief: "non-metric claims can still be audited",
      prediction: "the claim will resolve with a complete contract",
      action: "observe the outcome",
      claims: [claim],
    }),
  });
  const contract = {
    expectedObservation: "review gate is approved in this cycle",
    timeWindow: "cycle_validation_window",
    successThreshold: "approved",
    failureThreshold: "not approved",
    uncertainty: 0.25,
  };

  const binary = await post({
    id: "claim_binary_contract",
    type: "binary",
    expected: "approved",
    actual: "approved",
    ...contract,
  });
  assert.equal(binary.status, 200);

  const directional = await post({
    id: "claim_directional_contract",
    type: "directional",
    expectedDirection: "up",
    actualDirection: "up",
    ...contract,
  });
  assert.equal(directional.status, 200);
});

test("project onboarding requires an explicit first claim operator", async () => {
  const payload = {
    name: "Onboarding Claim Required",
    oneLiner: "Validate onboarding claim schema",
    targetUser: "operators",
    currentHypothesis: "first claim must be explicit",
    firstClaimMetric: "activation_rate",
    firstClaimTarget: 0.3,
    firstSignal: "activation_rate is observable",
  };
  const missingOperator = await fetch(url("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(missingOperator.status, 400);

  const equalityOperator = await fetch(url("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, firstClaimOperator: "==" }),
  });
  assert.equal(equalityOperator.status, 400);
});

test("project patch accepts redline arrays and rejects json encoded redlines", async () => {
  const encoded = await fetch(url("/api/projects/proj_validation"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redlines: JSON.stringify(["no unreviewed external writes"]) }),
  });
  assert.equal(encoded.status, 400);

  const valid = await fetch(url("/api/projects/proj_validation"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redlines: ["no unreviewed external writes", "no silent schema drift"],
      firstClaimOperator: "<=",
      firstClaimTarget: 200,
    }),
  });
  assert.equal(valid.status, 200);
  const body = await valid.json() as any;
  assert.deepEqual(body.redlines, ["no unreviewed external writes", "no silent schema drift"]);
  assert.equal(body.firstClaimOperator, "<=");
});

test("meaning gate approval rolls back gate decision when knowledge creation fails", () => {
  let gate: any = {
    id: "gate_meaning_rollback",
    cycleId: "cycle_validation",
    type: "meaning",
    blocking: 0,
    title: "Meaning gate rollback",
    payload: JSON.stringify({ summary: "rollback this approval", externalId: "test:rollback" }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  };
  let decisions: unknown[] = [];
  let events: unknown[] = [];
  let ledgers: unknown[] = [];
  const fakeStore: any = {
    withTransaction<T>(fn: () => T): T {
      const snapshot = {
        gate: { ...gate },
        decisions: [...decisions],
        events: [...events],
        ledgers: [...ledgers],
      };
      try {
        return fn();
      } catch (error) {
        gate = snapshot.gate;
        decisions = snapshot.decisions;
        events = snapshot.events;
        ledgers = snapshot.ledgers;
        throw error;
      }
    },
    getGate: (id: string) => (id === gate.id ? gate : undefined),
    getCycle: (id: string) => (id === "cycle_validation" ? { id, projectId: "proj_validation", idx: 1 } : undefined),
    updateGate: (_id: string, patch: Record<string, unknown>) => {
      gate = { ...gate, ...patch, version: gate.version + 1 };
      return gate;
    },
    createDecision: (decision: unknown) => {
      decisions.push(decision);
      return decision;
    },
    recordEvent: (event: unknown) => {
      events.push(event);
    },
    upsertActionLedger: (entry: unknown) => {
      ledgers.push(entry);
      return entry;
    },
    getKnowledge: () => undefined,
    createKnowledge: () => {
      throw new Error("knowledge insert failed");
    },
  };

  const service = new HumanGateService(fakeStore);
  assert.throws(() => service.approve(gate.id, { rationale: "approve but fail insert" }), /knowledge insert failed/);
  assert.equal(gate.status, "pending");
  assert.equal(gate.decision, null);
  assert.equal(decisions.length, 0);
  assert.equal(events.length, 0);
  assert.equal(ledgers.length, 0);
});

test("knowledge create and patch validate required fields and dangerous markup", async () => {
  const dangerous = await fetch(url("/api/knowledge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "proj_validation",
      title: "<script>alert(1)</script>",
      content: "unsafe",
    }),
  });
  assert.equal(dangerous.status, 400);

  const valid = await fetch(url("/api/knowledge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "kb_validation",
      projectId: "proj_validation",
      title: "Validated knowledge",
      content: "Schema validated content",
      tags: ["validation"],
      cycleIdx: 1,
    }),
  });
  assert.equal(valid.status, 200);

  const invalidPatch = await fetch(url("/api/knowledge/kb_validation"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "javascript:alert(1)" }),
  });
  assert.equal(invalidPatch.status, 400);

  const patched = await fetch(url("/api/knowledge/kb_validation"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: `reviewed at ${now()}` }),
  });
  assert.equal(patched.status, 200);
});

test("org module patch rejects invalid body before storage update", async () => {
  const response = await fetch(url("/api/org-modules/org_validation"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ responsibilityBoundaries: "not-an-array" }),
  });
  assert.equal(response.status, 400);
});

test("id params reject malformed values before storage access", async () => {
  const response = await fetch(url("/api/knowledge/not-a-valid-id-because-it-has-%24"));
  assert.equal(response.status, 400);
});

test("human gate decision comes from route path, not body decision", async () => {
  const response = await fetch(url("/api/human-gates/gate_validation/approve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "reject", rationale: "approved intentionally" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.status, "approved");
  assert.equal(body.decision, "approve");
});

test("knowledge reviews route filters review_required status without resolved history", async () => {
  storage.createKnowledge({
    id: "kb_route_review_strong",
    projectId: "proj_validation",
    type: "principle",
    title: "Route review strong",
    content: "route_review_score >= 0.8",
    sourceType: "test",
    sourceRef: "route-review-strong",
    evidenceAlpha: 8,
    evidenceBeta: 1,
    confidenceScore: 0.9,
    confidenceLevel: "high",
    status: "strong",
    humanApprovedCount: 1,
    externalVerifiedCount: 1,
    validFrom: "2026-01-01",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: "owner",
    usageCount: 0,
    lastInjectedAt: null,
    lastVerifiedAt: Date.parse("2026-01-01T00:00:00Z"),
    lastDecayedAt: null,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: 1,
    tags: JSON.stringify(["route_review"]),
    notes: "",
    supersededBy: null,
    semanticKey: "route_review_score",
    version: 1,
  });
  storage.createKnowledge({
    id: "kb_route_review_candidate",
    projectId: "proj_validation",
    type: "principle",
    title: "Route review candidate",
    content: "route_review_score <= 0.2",
    sourceType: "test",
    sourceRef: "route-review-candidate",
    evidenceAlpha: 2,
    evidenceBeta: 2,
    confidenceScore: 0.6,
    confidenceLevel: "medium",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-01-01",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    lastInjectedAt: null,
    lastVerifiedAt: Date.parse("2026-01-01T00:00:00Z"),
    lastDecayedAt: null,
    storageStrength: 1,
    noveltyScore: null,
    sourceRound: 1,
    tags: JSON.stringify(["route_review"]),
    notes: "",
    supersededBy: null,
    semanticKey: "route_review_score",
    version: 1,
  });

  detectKnowledgeConflicts("proj_validation");
  const pendingResponse = await fetch(url("/api/projects/proj_validation/knowledge-reviews?status=pending&reviewType=conflict"));
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json() as any[];
  assert.ok(pending.some((review) => review.primaryKnowledgeId === "kb_route_review_candidate"));
  assert.ok(pending.every((review) => review.status === "review_required"));

  const review = pending.find((item) => item.primaryKnowledgeId === "kb_route_review_candidate");
  resolveKnowledgeReview(review.id, {
    action: "quarantine",
    actor: "human",
    rationale: "route filter test resolution",
  });

  const afterPending = await fetch(url("/api/projects/proj_validation/knowledge-reviews?status=pending&reviewType=conflict"));
  assert.equal(afterPending.status, 200);
  const afterPendingBody = await afterPending.json() as any[];
  assert.ok(!afterPendingBody.some((item) => item.id === review.id));

  const resolvedResponse = await fetch(url("/api/projects/proj_validation/knowledge-reviews?status=resolved&reviewType=conflict"));
  assert.equal(resolvedResponse.status, 200);
  const resolved = await resolvedResponse.json() as any[];
  assert.ok(resolved.some((item) => item.id === review.id));
  assert.ok(resolved.every((reviewItem) => reviewItem.status === "resolved"));
});
