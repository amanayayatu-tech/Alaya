import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-cap-test-")), "test.db");
process.env.ALAYA_MODE = "shadow";
process.env.ALAYA_API_KEY = "unit-api-key-for-capability-gate";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { evaluateCapability, checkCapability } = await import("../server/security/capabilities.ts");

test("shadow mode defaults write capabilities to dry-run and audits the decision", () => {
  const decision = checkCapability({
    actor: "test",
    capability: "knowledge_write",
    target: "POST /api/knowledge",
    payload: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.dryRun, true);

  const action = storage.listActionLedger().at(-1);
  assert.equal(action?.actionType, "capability.knowledge_write");
  assert.equal(action?.status, "dry_run");
  assert.equal(action?.payload.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
});

test("production high-risk capabilities are denied unless explicitly enabled", () => {
  const denied = evaluateCapability("shell_execution", {
    ALAYA_MODE: "production",
  } as NodeJS.ProcessEnv);
  assert.equal(denied.allowed, false);
  assert.equal(denied.dryRun, false);

  const allowed = evaluateCapability("shell_execution", {
    ALAYA_MODE: "production",
    ALAYA_CAP_SHELL_EXECUTION: "true",
  } as NodeJS.ProcessEnv);
  assert.equal(allowed.allowed, true);
});

test("test mode allows LLM and unknown network for local fake-provider tests", () => {
  const llm = evaluateCapability("llm_call", { NODE_ENV: "test" } as NodeJS.ProcessEnv);
  const network = evaluateCapability("network_unknown", { NODE_ENV: "test" } as NodeJS.ProcessEnv);
  assert.equal(llm.allowed, true);
  assert.equal(network.allowed, true);
});
