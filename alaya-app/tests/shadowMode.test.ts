import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-shadow-test-")), "test.db");
process.env.ALAYA_MODE = "shadow";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_API_KEY = "unit-api-key-for-shadow-mode";

const { storage } = await import("../server/storage.ts");
const { registerRoutes } = await import("../server/routes.ts");

const app = express();
app.use(express.json());
const server = createServer(app);
await registerRoutes(server, app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.ALAYA_API_KEY}`,
};

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("shadow mode records mutating API requests as dry-run without executing writes", async () => {
  process.env.ALAYA_MODE = "shadow";
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/knowledge`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      id: "kb_shadow_should_not_persist",
      projectId: "proj_shadow",
      title: "shadow write",
      content: "must not persist",
    }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 202);
  assert.equal(body.status, "dry_run");
  assert.equal(storage.getKnowledge("kb_shadow_should_not_persist"), undefined);
  assert.equal(storage.listActionLedger().some((action) => action.status === "dry_run"), true);
});

test("production mode rejects mutating API requests before handlers write", async () => {
  process.env.ALAYA_MODE = "production";
  delete process.env.ALAYA_CAP_KNOWLEDGE_WRITE;
  const address = server.address() as AddressInfo;
  const before = storage.listProjects().length;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "prod write should fail",
      oneLiner: "blocked",
      targetUser: "operator",
      direction: "deny write",
      redlines: [],
    }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 403);
  assert.equal(body.capability, "knowledge_write");
  assert.equal(storage.listProjects().length, before);

  const blocked = storage.listActionLedger().find((action) => (
    action.actionType === "capability.knowledge_write" &&
    action.status === "blocked" &&
    action.target === "POST /projects"
  ));
  assert.ok(blocked);
  process.env.ALAYA_MODE = "shadow";
});

test("new governed API routes use explicit capability classes in long-run modes", async () => {
  const address = server.address() as AddressInfo;

  process.env.ALAYA_MODE = "shadow";
  const orgResponse = await fetch(`http://127.0.0.1:${address.port}/api/org-modules/org_shadow_module`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ ownerRole: "operator" }),
  });
  const orgBody = await orgResponse.json() as any;
  assert.equal(orgResponse.status, 202);
  assert.equal(orgBody.capability, "knowledge_write");

  process.env.ALAYA_MODE = "production";
  delete process.env.ALAYA_CAP_SHELL_EXECUTION;
  const builderResponse = await fetch(`http://127.0.0.1:${address.port}/api/builder/codex/apply`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      dryRun: false,
      package: {
        projectId: "proj_builder_cap",
        goal: "capability mapping",
        affectedFiles: ["server/routes.ts"],
        diffSummary: "noop",
        testPlan: ["npm run guard"],
        rollbackPlan: ["do not apply"],
        riskLevel: "local_write",
        idempotencyKey: "idem_builder_capability_mapping",
        auditSummary: "mapping test",
        dryRun: true,
        adapter: "codex_cli",
      },
    }),
  });
  const builderBody = await builderResponse.json() as any;
  assert.equal(builderResponse.status, 403);
  assert.equal(builderBody.capability, "shell_execution");

  const canaryResponse = await fetch(`http://127.0.0.1:${address.port}/api/projects/proj_canary_cap/provider-canary`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ provider: "openai" }),
  });
  const canaryBody = await canaryResponse.json() as any;
  assert.equal(canaryResponse.status, 403);
  assert.equal(canaryBody.capability, "llm_call");

  assert.equal(storage.listActionLedger().some((action) => action.actionType === "capability.shell_execution"), true);
  assert.equal(storage.listActionLedger().some((action) => action.actionType === "capability.llm_call"), true);
  process.env.ALAYA_MODE = "shadow";
});
