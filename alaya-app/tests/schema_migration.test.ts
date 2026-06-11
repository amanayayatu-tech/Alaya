import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-schema-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage, rawDb } = await import("../server/storage.ts");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("knowledge_items migration adds maturity and injection fields without breaking existing writes", () => {
  const columns = new Set(
    (rawDb.prepare("PRAGMA table_info(knowledge_items)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of [
    "superseded_by",
    "usage_count",
    "last_injected_at",
    "last_verified_at",
    "last_decayed_at",
    "storage_strength",
    "novelty_score",
    "source_round",
  ]) {
    assert.equal(columns.has(name), true, `${name} should exist`);
  }

  const llmColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of ["provider", "model", "route_reason", "token_source"]) {
    assert.equal(llmColumns.has(name), true, `llm_calls.${name} should exist`);
  }

  const cycleColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(cycles)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of [
    "speculative",
    "parent_cycle_id",
    "depends_on",
    "assumed_outcomes",
    "draft_status",
    "apply_scheduled_at",
    "applied_at",
    "co_applied_set",
  ]) {
    assert.equal(cycleColumns.has(name), true, `cycles.${name} should exist`);
  }

  const gateColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(human_gate_items)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of [
    "notify_policy",
    "defer_until",
    "reject_reason_code",
    "review_dwell_ms",
    "evidence_revalidated_at",
    "evidence_changed",
    "missed_windows",
  ]) {
    assert.equal(gateColumns.has(name), true, `human_gate_items.${name} should exist`);
  }

  const tables = new Set(
    (rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name),
  );
  assert.equal(tables.has("trace_events"), true, "trace_events table should exist");
  assert.equal(tables.has("action_ledger"), true, "action_ledger table should exist");
  assert.equal(tables.has("review_sessions"), true, "review_sessions table should exist");
  assert.equal(tables.has("notification_digests"), true, "notification_digests table should exist");
  assert.equal(tables.has("sensor_error_accumulators"), true, "sensor_error_accumulators table should exist");
  assert.equal(tables.has("pending_attributions"), true, "pending_attributions table should exist");
  assert.equal(tables.has("distiller_proposals"), true, "distiller_proposals table should exist");
  assert.equal(tables.has("gold_cases"), true, "gold_cases table should exist");

  const sensorColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(sensor_error_accumulators)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of ["fingerprint", "project_id", "source", "error_kind", "occurrence_count", "event_timestamps_ms", "first_seen_at", "last_seen_at"]) {
    assert.equal(sensorColumns.has(name), true, `sensor_error_accumulators.${name} should exist`);
  }

  const pendingColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(pending_attributions)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of ["id", "project_id", "fingerprint", "error_type", "claim_error", "context", "confidence", "status", "gate_id", "resolved_at", "created_at"]) {
    assert.equal(pendingColumns.has(name), true, `pending_attributions.${name} should exist`);
  }

  const proposalColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(distiller_proposals)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of ["id", "project_id", "cycle_id", "proposal_type", "target_knowledge_id", "proposed_content", "attribution_basis", "regression_status", "regression_failed_cases", "gate_id", "status", "created_at"]) {
    assert.equal(proposalColumns.has(name), true, `distiller_proposals.${name} should exist`);
  }

  const goldColumns = new Set(
    (rawDb.prepare("PRAGMA table_info(gold_cases)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const name of ["id", "project_id", "fingerprint", "input", "expected_error_type", "expected_route", "active", "retired_reason", "last_confirmed_at", "source_proposal_id", "created_at"]) {
    assert.equal(goldColumns.has(name), true, `gold_cases.${name} should exist`);
  }

  const accumulator = storage.upsertSensorErrorAccumulator({
    fingerprint: "proj_schema:device:data_missing",
    projectId: "proj_schema",
    source: "device",
    errorKind: "data_missing",
    occurrenceCount: 1,
    eventTimestampsMs: JSON.stringify([Date.parse("2026-06-11T00:00:00.000Z")]),
    firstSeenAt: "2026-06-11T00:00:00.000Z",
    lastSeenAt: "2026-06-11T00:00:00.000Z",
    version: 1,
  });
  assert.equal(accumulator.occurrenceCount, 1);
  assert.equal(storage.listSensorErrorAccumulators("proj_schema").length, 1);

  const pending = storage.createPendingAttribution({
    id: "pa_schema_1",
    projectId: "proj_schema",
    fingerprint: "proj_schema:activation_rate:model",
    errorType: "model",
    claimError: 0.55,
    context: JSON.stringify({ metric: "activation_rate" }),
    confidence: 0.65,
    status: "pending",
    gateId: null,
    resolvedAt: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    version: 1,
  });
  assert.equal(pending.status, "pending");
  assert.equal(storage.listPendingAttributions("proj_schema", { fingerprint: pending.fingerprint }).length, 1);
  assert.equal(storage.updatePendingAttribution(pending.id, { status: "released", resolvedAt: "2026-06-11T00:01:00.000Z" })?.status, "released");

  storage.createCycle({
    id: "cycle_schema",
    projectId: "proj_schema",
    idx: 1,
    goal: "schema",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
  const proposal = storage.createDistillerProposal({
    id: "dp_schema_1",
    projectId: "proj_schema",
    cycleId: "cycle_schema",
    proposalType: "create",
    targetKnowledgeId: null,
    proposedContent: JSON.stringify({ title: "schema proposal" }),
    attributionBasis: JSON.stringify({ attributionConfidence: 1 }),
    regressionStatus: "pending",
    regressionFailedCases: null,
    gateId: null,
    status: "proposed",
    createdAt: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(proposal.status, "proposed");
  assert.equal(storage.updateDistillerProposal(proposal.id, { regressionStatus: "passed", status: "gated" })?.status, "gated");

  const gold = storage.createGoldCase({
    id: "gold_schema_1",
    projectId: "proj_schema",
    fingerprint: "proj_schema:activation_rate:model",
    input: JSON.stringify({ claimError: 0.8, context: {} }),
    expectedErrorType: "model",
    expectedRoute: "distiller_world_model_update",
    active: 1,
    retiredReason: null,
    lastConfirmedAt: null,
    sourceProposalId: null,
    createdAt: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(gold.active, 1);
  assert.equal(storage.updateGoldCase(gold.id, { active: 0, retiredReason: "schema retirement" })?.active, 0);

  assert.ok(storage.listEvents().find((event) => event.tableName === "sensor_error_accumulators"));
  assert.ok(storage.listEvents().find((event) => event.tableName === "pending_attributions" && event.op === "update"));
  assert.ok(storage.listEvents().find((event) => event.tableName === "distiller_proposals" && event.op === "update"));
  assert.ok(storage.listEvents().find((event) => event.tableName === "gold_cases" && event.op === "update"));

  storage.createKnowledge({
    id: "kb_schema_1",
    projectId: "proj_schema",
    type: "principle",
    title: "高风险动作必须可预览",
    content: "高风险动作执行前需要 preview、rollback 和 audit 约束。",
    sourceType: "metric",
    sourceRef: "schema-test",
    evidenceAlpha: 2,
    evidenceBeta: 1,
    confidenceScore: 2 / 3,
    confidenceLevel: "medium",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: 2,
    createdByCycle: 2,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["preview", "rollback", "audit"]),
    notes: "",
    version: 1,
  });

  const created = storage.getKnowledge("kb_schema_1");
  assert.equal(created?.usageCount, 0);
  assert.equal(created?.lastInjectedAt, null);
  assert.equal(created?.lastVerifiedAt, null);
  assert.equal(created?.lastDecayedAt, null);
  assert.equal(created?.storageStrength, 1);
  assert.equal(created?.noveltyScore, null);
  assert.equal(created?.sourceRound, 2);

  const injectedAt = Date.parse("2026-06-04T10:00:00.000Z");
  const updated = storage.updateKnowledge("kb_schema_1", {
    usageCount: 1,
    lastInjectedAt: injectedAt,
    lastVerifiedAt: injectedAt,
    lastDecayedAt: injectedAt,
    storageStrength: 0.82,
    noveltyScore: 0.64,
    sourceRound: 2,
    actor: "knowledge_injection",
  });

  assert.equal(updated?.usageCount, 1);
  assert.equal(updated?.lastInjectedAt, injectedAt);
  assert.equal(updated?.lastVerifiedAt, injectedAt);
  assert.equal(updated?.lastDecayedAt, injectedAt);
  assert.equal(updated?.storageStrength, 0.82);
  assert.equal(updated?.noveltyScore, 0.64);
  assert.equal(updated?.sourceRound, 2);

  const audit = storage.listEvents().find((event) => event.tableName === "knowledge_items" && event.actor === "knowledge_injection");
  assert.ok(audit, "knowledge update should be audited with the provided actor");
});

test("knowledge FTS migration rebuilds existing rows from legacy databases", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "alaya-legacy-fts-")), "legacy.db");
  const script = `
    import Database from "better-sqlite3";
    const db = new Database(process.env.ALAYA_DB_PATH);
    db.exec(\`
      CREATE TABLE knowledge_items (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL DEFAULT '', evidence_alpha REAL NOT NULL DEFAULT 1,
        evidence_beta REAL NOT NULL DEFAULT 1, confidence_score REAL NOT NULL DEFAULT 0.5,
        confidence_level TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'draft',
        human_approved_count INTEGER NOT NULL DEFAULT 0, external_verified_count INTEGER NOT NULL DEFAULT 0,
        valid_from TEXT NOT NULL DEFAULT '', valid_until TEXT,
        last_validated_cycle INTEGER NOT NULL DEFAULT 0, created_by_cycle INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT 'distiller', approved_by TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '', superseded_by TEXT, semantic_key TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO knowledge_items (
        id, project_id, type, title, content, source_type, source_ref,
        evidence_alpha, evidence_beta, confidence_score, confidence_level, status,
        human_approved_count, external_verified_count, valid_from, valid_until,
        last_validated_cycle, created_by_cycle, created_by, approved_by,
        usage_count, tags, notes, superseded_by, semantic_key, version
      ) VALUES (
        'kb_legacy_fts', 'proj_legacy_fts', 'principle',
        'legacy rollback audit preview principle',
        'legacy rollback audit preview knowledge should survive fts migration',
        'metric', 'legacy-test', 5, 1, 0.83, 'high', 'active',
        0, 1, '2026-06-04', NULL, 2, 2, 'distiller', NULL,
        0, '["rollback","audit","preview"]', '', NULL, '', 1
      );
    \`);
    db.close();
    const { buildKnowledgeContext } = await import("./server/knowledgeInjection.ts");
    const context = buildKnowledgeContext("legacy rollback audit preview", "proj_legacy_fts", { nowMs: 1780000000000 });
    if (!context.includes("kb_legacy_fts")) throw new Error(context || "missing legacy FTS row");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: appRoot,
    env: { ...process.env, ALAYA_DB_PATH: dbPath, ALAYA_LLM_PROVIDER: "mock" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
