import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-scenario-boundary-")), "test.db");
process.env.ALAYA_MODE = "development";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_API_KEY = "scenario-boundary-test-key";
process.env.ALAYA_CAP_KNOWLEDGE_WRITE = "true";
process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "false";

const { rawDb, storage } = await import("../server/storage.ts");
const { isScenarioDemoAllowed } = await import("../server/config/env.ts");
const { runFullCycle } = await import("../server/flywheel.ts");
const { seedDemo } = await import("../server/seed.ts");
const { registerRoutes } = await import("../server/routes.ts");

const app = express();
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status ?? 500).json({ message: error.message });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("default local development remains a mock scenario demo", () => {
  assert.equal(isScenarioDemoAllowed({}), true);
  assert.equal(isScenarioDemoAllowed({ NODE_ENV: "test" }), false);
  assert.equal(isScenarioDemoAllowed({ NODE_ENV: "production" }), false);
});

test("non-demo modes and provider overrides reject core, seed and HTTP before database mutation", async () => {
  for (const patch of [
    { ALAYA_MODE: "test" },
    { ALAYA_MODE: "shadow" },
    { ALAYA_MODE: "staging" },
    { ALAYA_MODE: "production" },
    { ALAYA_MODE: "invalid" },
    { ALAYA_LLM_PROVIDER: "openai" },
    { ALAYA_SENSOR_PROVIDER: "openai" },
    { ALAYA_MODEL_ROUTING_JSON: JSON.stringify({ builder: { provider: "openai" } }) },
  ]) {
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
    Object.assign(process.env, patch);
    try {
      const before = rawDb.serialize();
      await assert.rejects(runFullCycle("proj_unused", "cycle_unused"), { status: 403 });
      await assert.rejects(seedDemo(), { status: 403 });
      for (const path of ["/api/seed-demo", "/api/cycles/cycle_unused/run-full", "/api/SEED-DEMO/", "/api/cycles/cycle_unused/RUN-FULL/"]) {
        const address = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.ALAYA_API_KEY}` },
        });
        assert.equal(response.status, 403, JSON.stringify(patch));
      }
      assert.deepEqual(rawDb.serialize(), before, `denied demo changed the database: ${JSON.stringify(patch)}`);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("mock demo records scenario approval and simulated execution and measurements", async () => {
  const { projectId } = await seedDemo();
  const cycles = storage.listCycles(projectId);
  assert.equal(cycles.length, 4);
  assert.ok(cycles.every((cycle) => cycle.status === "closed"));
  assert.ok(storage.listKnowledge(projectId).every((knowledge) => knowledge.status !== "strong"));
  const approvals = rawDb.prepare("SELECT actor FROM event_log WHERE table_name='decision_log'").all() as Array<{ actor: string }>;
  assert.ok(approvals.length >= 4);
  assert.ok(approvals.every((event) => event.actor === "scenario"));
  const traces = storage.listTraceEventsByProject(projectId).filter((event) => event.name === "direction_gate_approved");
  assert.equal(traces.length, 4);
  assert.ok(traces.every((event) => event.agent === "scenario" && JSON.parse(event.attributes).simulated === true));
  for (const cycle of cycles) {
    const task = storage.listTasks(cycle.id).find((item) => item.agent === "builder");
    assert.ok(task);
    const spec = JSON.parse(task.spec);
    assert.equal(spec.simulatedBuildSuccess, true);
    assert.equal(spec.toolReportedBuildSuccess, undefined);
    const observations = storage.listObservations(cycle.id);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, "scenario_simulation");
    const predictions = storage.listPredictions(cycle.id);
    assert.equal(predictions.length, 1);
    assert.match(predictions[0].observation ?? "", /模拟情景/);
  }
  const gate = storage.listGates(projectId).find((item) => item.status === "pending" && item.type === "meaning");
  assert.ok(gate);
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/human-gates/${gate.id}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ALAYA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rationale: "Reviewed by the user in this test" }),
  });
  assert.equal(response.status, 200);
  const humanAudit = rawDb.prepare("SELECT actor FROM event_log WHERE table_name='decision_log' ORDER BY id DESC LIMIT 1").get() as { actor: string };
  assert.equal(humanAudit.actor, "human");
});
