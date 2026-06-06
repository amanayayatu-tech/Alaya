import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-redaction-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { redactSensitiveText, redactSensitiveData } = await import("../server/security/redact.ts");

test("redactSensitiveText covers tokens, auth headers, cookies, database URLs and private keys", () => {
  const raw = [
    "Authorization: Bearer sk-test012345678901234567890123",
    "Cookie: session=secret-cookie-value; other=value",
    "postgres://user:pass@db.example.com:5432/alaya",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactSensitiveText(raw);
  assert.equal(redacted.includes("sk-test012345678901234567890123"), false);
  assert.equal(redacted.includes("secret-cookie-value"), false);
  assert.equal(redacted.includes("user:pass"), false);
  assert.equal(redacted.includes("github_pat_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.includes("BEGIN PRIVATE KEY"), false);
  assert.match(redacted, /\[redacted-token\]/);
  assert.match(redacted, /\[redacted-cookie\]/);
  assert.match(redacted, /\[redacted-password\]/);
});

test("redactSensitiveText redacts phone numbers without removing dates or grouped ids", () => {
  const redacted = redactSensitiveText("Date 2026-06-06 build 1234-5678 phone +1 415 555 1212");
  assert.equal(redacted.includes("2026-06-06"), true);
  assert.equal(redacted.includes("1234-5678"), true);
  assert.equal(redacted.includes("+1 415 555 1212"), false);
  assert.equal(redacted.includes("+[redacted-phone]"), false);
  assert.match(redacted, /\[redacted-phone\]/);
});

test("redactSensitiveData redacts secret-like keys recursively", () => {
  const out = redactSensitiveData({
    ok: "keep",
    nested: {
      token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    },
  }) as any;
  assert.equal(out.ok, "keep");
  assert.equal(out.nested.token, "[redacted-secret]");
  assert.equal(out.nested.Authorization, "[redacted-secret]");
});

test("trace and action ledger persistence redact secret payloads", async () => {
  const { recordTrace } = await import("../server/trace.ts");
  const { recordActionProposal } = await import("../server/actionLedger.ts");

  const trace = recordTrace({
    projectId: "proj_redact",
    kind: "audit",
    name: "redaction_check",
    attributes: {
      Authorization: "Bearer sk-test012345678901234567890123",
      nested: { databaseUrl: "postgres://user:pass@db.example.com/alaya" },
    },
  });
  assert.equal(trace.attributes.includes("sk-test012345678901234567890123"), false);
  assert.equal(trace.attributes.includes("user:pass"), false);
  assert.match(trace.attributes, /\[redacted-secret\]/);

  const action = recordActionProposal({
    projectId: "proj_redact",
    actionType: "github.createIssue",
    target: "github",
    explicitRiskLevel: "external_write",
    payload: {
      token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      body: "password=supersecret123",
    },
    auditSummary: {
      apiKey: "sk-test012345678901234567890123",
    },
  });
  assert.equal(action.payload.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(action.payload.includes("supersecret123"), false);
  assert.equal(action.auditSummary?.includes("sk-test012345678901234567890123"), false);
});
