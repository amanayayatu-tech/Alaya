import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-healthz-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { registerRoutes } = await import("../server/routes.ts");

const app = express();
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("healthz and readyz expose distinct liveness and readiness semantics", async () => {
  const address = server.address() as AddressInfo;
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  const healthBody = await health.json() as any;
  const readyBody = await ready.json() as any;
  assert.equal(health.status, 200);
  assert.equal(healthBody.status, "ok");
  assert.equal(ready.status, 200);
  assert.equal(readyBody.status, "ready");
  assert.ok(readyBody.checks.database);
});

test("metrics endpoint emits Prometheus-style core long-run metrics", async () => {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  const text = await response.text();
  assert.equal(response.status, 200);
  for (const metric of [
    "alaya_uptime_seconds",
    "alaya_mode_info",
    "alaya_actions_total",
    "alaya_llm_requests_total",
    "alaya_llm_estimated_cost_usd_total",
    "alaya_knowledge_injections_total",
    "alaya_errors_total",
  ]) {
    assert.match(text, new RegExp(metric));
  }
});
