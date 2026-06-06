import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-http-security-test-")), "test.db");
process.env.ALAYA_MODE = "shadow";
process.env.ALAYA_API_KEY = "unit-api-key-for-http-security";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_CAP_KNOWLEDGE_WRITE = "true";
process.env.ALAYA_CAP_SCHEDULER_LOOP = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_CORS_ORIGINS = "https://alaya.example.test";
process.env.ALAYA_TRUST_PROXY = "true";
process.env.ALAYA_COST_RATE_LIMIT_MAX = "1";
process.env.ALAYA_COST_RATE_LIMIT_WINDOW_MS = "60000";

const { registerRoutes } = await import("../server/routes.ts");
const { corsMiddleware, securityHeadersMiddleware, costEndpointRateLimit } = await import("../server/security/http.ts");

const app = express();
app.use(securityHeadersMiddleware);
app.use(corsMiddleware);
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

function url(path: string) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${path}`;
}

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${process.env.ALAYA_API_KEY}`, ...extra };
}

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("api routes require bearer auth in shadow mode while healthz stays public", async () => {
  const noAuth = await fetch(url("/api/projects"));
  assert.equal(noAuth.status, 401);

  const wrongAuth = await fetch(url("/api/projects"), { headers: { Authorization: "Bearer wrong" } });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await fetch(url("/api/projects"), { headers: authHeaders() });
  assert.equal(okAuth.status, 200);

  const health = await fetch(url("/healthz"));
  assert.equal(health.status, 200);
});

test("metrics is loopback-only unless an allowed CIDR is configured", async () => {
  const loopback = await fetch(url("/metrics"));
  assert.equal(loopback.status, 200);

  const denied = await fetch(url("/metrics"), { headers: { "X-Forwarded-For": "203.0.113.20" } });
  assert.equal(denied.status, 403);
});

test("security headers and CORS whitelist are applied", async () => {
  const allowed = await fetch(url("/healthz"), { headers: { Origin: "https://alaya.example.test" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://alaya.example.test");
  assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
  assert.equal(allowed.headers.get("x-frame-options"), "DENY");
  assert.match(allowed.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);

  const denied = await fetch(url("/healthz"), { headers: { Origin: "https://evil.example.test" } });
  assert.equal(denied.status, 403);
});

test("high-cost endpoints are rate limited without affecting health", async () => {
  const firstRunFull = await fetch(url("/api/cycles/cycle_missing/run-full"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: "{}",
  });
  assert.equal(firstRunFull.status, 404);

  const secondRunFull = await fetch(url("/api/cycles/cycle_missing/run-full"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: "{}",
  });
  assert.equal(secondRunFull.status, 429);

  const firstScheduler = await fetch(url("/api/scheduler/tick"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ projectId: "proj_missing" }),
  });
  assert.equal(firstScheduler.status, 404);

  const secondScheduler = await fetch(url("/api/scheduler/tick"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ projectId: "proj_missing" }),
  });
  assert.equal(secondScheduler.status, 429);

  const health = await fetch(url("/healthz"));
  assert.equal(health.status, 200);
});

test("invalid rate-limit env values fall back instead of disabling the limiter", async () => {
  const oldMax = process.env.ALAYA_COST_RATE_LIMIT_MAX;
  const oldWindow = process.env.ALAYA_COST_RATE_LIMIT_WINDOW_MS;
  process.env.ALAYA_COST_RATE_LIMIT_MAX = "not-a-number";
  process.env.ALAYA_COST_RATE_LIMIT_WINDOW_MS = "also-not-a-number";

  const limitedApp = express();
  const limitedServer = createServer(limitedApp);
  limitedApp.post("/limited", costEndpointRateLimit(`invalid-env-${Date.now()}`), (_req, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
  const address = limitedServer.address() as AddressInfo;
  const limitedUrl = `http://127.0.0.1:${address.port}/limited`;
  try {
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(limitedUrl, { method: "POST" });
      assert.equal(response.status, 200);
    }
    const blocked = await fetch(limitedUrl, { method: "POST" });
    assert.equal(blocked.status, 429);
  } finally {
    if (oldMax == null) delete process.env.ALAYA_COST_RATE_LIMIT_MAX;
    else process.env.ALAYA_COST_RATE_LIMIT_MAX = oldMax;
    if (oldWindow == null) delete process.env.ALAYA_COST_RATE_LIMIT_WINDOW_MS;
    else process.env.ALAYA_COST_RATE_LIMIT_WINDOW_MS = oldWindow;
    await new Promise<void>((resolve, reject) => limitedServer.close((err) => (err ? reject(err) : resolve())));
  }
});
