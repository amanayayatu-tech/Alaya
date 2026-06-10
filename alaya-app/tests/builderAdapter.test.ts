import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-builder-adapter-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";
delete process.env.ALAYA_CAP_SHELL_EXECUTION;

const { storage } = await import("../server/storage.ts");
const { CodexCliBuilderAdapter, validateChangePackage } = await import("../server/builderAdapter.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");

const gateService = new HumanGateService(storage);

function approveGate(gateId: string, decision = "approve") {
  gateService.systemResolve(gateId, decision, {
    actor: "test",
    status: "approved",
    via: "test",
    reason: "test fixture approval",
  });
}

function seed() {
  storage.createProject({
    id: "proj_builder_adapter",
    name: "Builder Adapter",
    direction: "governed change packages",
    targetUser: "operators",
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
    id: "cycle_builder_adapter",
    projectId: "proj_builder_adapter",
    idx: 1,
    goal: "generate rollback-ready package",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

seed();

test("Codex CLI adapter generates a valid dry-run change package and audits the attempt", async () => {
  const adapter = new CodexCliBuilderAdapter();
  const pkg = await adapter.generateChangePackage({
    projectId: "proj_builder_adapter",
    cycleId: "cycle_builder_adapter",
    goal: "Add validation for a small route",
    requestedFiles: ["alaya-app/server/routes.ts"],
  });

  assert.deepEqual(validateChangePackage(pkg), []);
  assert.equal(pkg.dryRun, true);
  assert.equal(pkg.affectedFiles[0], "alaya-app/server/routes.ts");
  assert.ok(pkg.rollbackPlan.length > 0);
  assert.ok(storage.listActionLedger("proj_builder_adapter").some((row) => row.actionType === "builder.codex_cli.generate_change_package"));
});

test("apply path is dry-run by default and never applies patches automatically", async () => {
  const adapter = new CodexCliBuilderAdapter();
  const pkg = await adapter.generateChangePackage({
    projectId: "proj_builder_adapter",
    cycleId: "cycle_builder_adapter",
    goal: "Dry-run apply only",
  });

  const result = await adapter.applyChangePackage(pkg);

  assert.equal(result.status, "dry_run");
  assert.equal(result.applied, false);
  assert.ok(storage.listActionLedger("proj_builder_adapter").some((row) => row.idempotencyKey === pkg.idempotencyKey && row.status === "dry_run"));
});

test("change package validation rejects invalid risk levels from untrusted input", async () => {
  const adapter = new CodexCliBuilderAdapter();
  const pkg = await adapter.generateChangePackage({
    projectId: "proj_builder_adapter",
    cycleId: "cycle_builder_adapter",
    goal: "Reject malformed risk",
  });
  const malformed = { ...pkg, riskLevel: "not_a_risk" as any };

  assert.match(validateChangePackage(malformed).join("; "), /riskLevel is invalid/);
  await assert.rejects(() => adapter.applyChangePackage(malformed), /riskLevel is invalid/);
});

test("non-dry-run apply is denied by default shell capability and logged", async () => {
  const adapter = new CodexCliBuilderAdapter();
  const pkg = await adapter.generateChangePackage({
    projectId: "proj_builder_adapter",
    cycleId: "cycle_builder_adapter",
    goal: "Require capability denial",
  });

  const result = await adapter.applyChangePackage(pkg, { dryRun: false });

  assert.equal(result.status, "blocked");
  assert.equal(result.applied, false);
  assert.match(result.reason, /default deny|ALAYA_CAP_SHELL_EXECUTION=false|shell/i);
  assert.ok(storage.listActionLedger("proj_builder_adapter").some((row) => row.actionType === "capability.shell_execution" && row.status === "blocked"));
});

test("approved risk gate with matching idempotency key is required before non-dry-run apply path", async () => {
  const previous = process.env.ALAYA_CAP_SHELL_EXECUTION;
  process.env.ALAYA_CAP_SHELL_EXECUTION = "true";
  try {
    const adapter = new CodexCliBuilderAdapter();
    const pkg = await adapter.generateChangePackage({
      projectId: "proj_builder_adapter",
      cycleId: "cycle_builder_adapter",
      goal: "Require matching risk gate",
      requestedFiles: ["README.md"],
    });

    const blocked = await adapter.applyChangePackage(pkg, { dryRun: false });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.approvalGateId);

    const wrongGate = storage.createGate({
      id: "gate_wrong_builder_apply",
      cycleId: "cycle_builder_adapter",
      type: "risk",
      blocking: 1,
      title: "wrong gate",
      payload: JSON.stringify({ riskKey: "builder_apply_change_package", idempotencyKey: "idem_wrong" }),
      status: "approved",
      estimatedMinutes: 1,
      decision: "approve",
      version: 1,
    });
    const stillBlocked = await adapter.applyChangePackage(pkg, { dryRun: false });
    assert.equal(stillBlocked.status, "blocked");
    assert.notEqual(stillBlocked.approvalGateId, wrongGate.id);

    approveGate(blocked.approvalGateId ?? "", "approve");
    const approved = await adapter.applyChangePackage(pkg, { dryRun: false });
    assert.equal(approved.status, "approved");
    assert.equal(approved.applied, false);
    assert.equal(approved.approvalGateId, blocked.approvalGateId);
  } finally {
    if (previous == null) delete process.env.ALAYA_CAP_SHELL_EXECUTION;
    else process.env.ALAYA_CAP_SHELL_EXECUTION = previous;
  }
});
