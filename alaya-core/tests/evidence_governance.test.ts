import test from "node:test";
import assert from "node:assert/strict";
import { classifyActionRisk, makeIdempotencyKey, requiresApproval } from "../src/core/action_risk.js";
import { transitionState, eligibleForHighRisk } from "../src/core/transition_state.js";
import { resolveModelRoute } from "../src/llm/model_router.js";
import type { KnowledgeItem } from "../src/core/types.js";

function knowledge(patch: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "kb_candidate",
    projectId: "proj",
    type: "principle",
    title: "Candidate principle",
    content: "Candidate evidence",
    sourceType: "metric",
    sourceRef: "test",
    evidenceAlpha: 2,
    evidenceBeta: 1,
    confidenceScore: 2 / 3,
    confidenceLevel: "medium",
    status: "candidate",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: [],
    notes: "",
    ...patch,
  };
}

test("candidate is a draft-compatible lifecycle state", () => {
  const result = transitionState(knowledge(), { currentCycle: 2, conflictsWithStrong: false });
  assert.equal(result.nextStatus, "active");
  assert.equal(result.changed, true);
});

test("deprecated and rejected knowledge do not re-enter high-risk evidence", () => {
  assert.equal(eligibleForHighRisk(knowledge({ status: "deprecated" })), false);
  assert.equal(eligibleForHighRisk(knowledge({ status: "rejected" })), false);
  assert.equal(transitionState(knowledge({ status: "rejected" }), { currentCycle: 3, conflictsWithStrong: false }).changed, false);
});

test("action risk classifies high-risk writes and produces stable idempotency keys", () => {
  const risk = classifyActionRisk({
    actionType: "github.createPullRequest",
    target: "delete stale workflow",
    payload: { repo: "Alaya", rollback: true },
  });
  assert.equal(risk, "destructive");
  assert.equal(requiresApproval(risk), true);

  const a = makeIdempotencyKey({
    projectId: "proj",
    cycleId: "cycle_4",
    actionType: "github.createPullRequest",
    target: "delete stale workflow",
    payload: { b: 2, a: 1 },
  });
  const b = makeIdempotencyKey({
    projectId: "proj",
    cycleId: "cycle_4",
    actionType: "github.createPullRequest",
    target: "delete stale workflow",
    payload: { a: 1, b: 2 },
  });
  assert.equal(a, b);
});

test("model router resolves role env over routing json over global env", () => {
  const route = resolveModelRoute("distiller", {
    ALAYA_LLM_PROVIDER: "openai",
    OPENAI_MODEL: "global-model",
    ALAYA_MODEL_ROUTING_JSON: JSON.stringify({
      default: { provider: "mock", model: "mock-default" },
      distiller: { provider: "openai", model: "json-distiller" },
    }),
    ALAYA_DISTILLER_MODEL: "role-distiller",
  });
  assert.equal(route.role, "distiller");
  assert.equal(route.provider, "openai");
  assert.equal(route.model, "role-distiller");
  assert.equal(route.routeReason, "role_env");
});
