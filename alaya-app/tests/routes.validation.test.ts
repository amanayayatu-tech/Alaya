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
      claims: [{ metric: "activation_rate", operator: ">=", target: 0.3 }],
    }),
  });
  assert.equal(valid.status, 200);
  const body = await valid.json() as any;
  assert.equal(body.cycleId, "cycle_validation");
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
